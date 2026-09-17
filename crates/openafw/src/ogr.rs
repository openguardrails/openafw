//! The OpenGuardrails connection (design §9): the `GET /v1/rules` feed with
//! its cache, and the `/v1/heartbeat` loop that learns of a ruleset change.
//! Everything here fails OPEN: a runtime that cannot be reached leaves the
//! agent working on the cached or bundled ruleset.

use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use afw_engine::{compile, Ruleset};
use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use crate::vault::home_dir;
use crate::AppState;

pub const INTEGRATION: &str = concat!("openafw/", env!("CARGO_PKG_VERSION"));

pub fn cache_path(runtime_url: &str) -> PathBuf {
    let h = hex::encode(Sha256::digest(runtime_url.as_bytes()));
    home_dir().join(format!("rules-{}.json", &h[..8]))
}

pub fn read_cache(runtime_url: &str) -> Option<Ruleset> {
    let text = std::fs::read_to_string(cache_path(runtime_url)).ok()?;
    Ruleset::from_json(&text).ok()
}

fn write_cache(runtime_url: &str, raw: &str) -> Result<()> {
    let path = cache_path(runtime_url);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let tmp = path.with_extension(format!("tmp.{}", std::process::id()));
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        use std::io::Write;
        opts.open(&tmp)?.write_all(raw.as_bytes())?;
    }
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

pub enum RulesOutcome {
    NotModified,
    Fetched(Ruleset),
    Failed(String),
}

/// `GET /v1/rules` with `If-None-Match` from the cached id. Never throws.
pub async fn fetch_rules(client: &reqwest::Client, runtime_url: &str, api_key: &str, cached_id: Option<&str>) -> RulesOutcome {
    let base = runtime_url.trim_end_matches('/');
    let mut req = client
        .get(format!("{base}/v1/rules"))
        .bearer_auth(api_key)
        .header("accept", "application/json")
        .timeout(Duration::from_secs(8));
    if let Some(id) = cached_id {
        req = req.header("if-none-match", format!("\"{id}\""));
    }
    let res = match req.send().await {
        Ok(r) => r,
        Err(e) => return RulesOutcome::Failed(format!("rules fetch failed: {e}")),
    };
    if res.status().as_u16() == 304 {
        return RulesOutcome::NotModified;
    }
    if !res.status().is_success() {
        return RulesOutcome::Failed(format!("rules answered {}", res.status()));
    }
    let raw = match res.text().await {
        Ok(t) => t,
        Err(e) => return RulesOutcome::Failed(format!("rules body unreadable: {e}")),
    };
    match Ruleset::from_json(&raw) {
        Ok(rs) => {
            if let Err(e) = write_cache(runtime_url, &raw) {
                tracing::warn!("rules cache not written: {e}");
            }
            RulesOutcome::Fetched(rs)
        }
        Err(e) => RulesOutcome::Failed(format!("rules answered a body without a ruleset: {e}")),
    }
}

/// Install a served ruleset into the running proxy.
pub fn install(state: &AppState, rs: &Ruleset, source: &str) {
    let compiled = compile(rs, state.tiers());
    for d in &compiled.disabled {
        tracing::warn!("rule {} disabled: {}", d.id, d.reason);
    }
    tracing::info!("ruleset {} ({source}): {} rules active, {} disabled", compiled.id, compiled.rules.len(), compiled.disabled.len());
    *state.compiled.write().unwrap() = Arc::new(compiled);
    *state.ruleset_source.write().unwrap() = source.to_string();
}

/// On start: cache first, then one fetch.
pub async fn load_on_start(state: &AppState, runtime_url: &str, api_key: &str) {
    if let Some(cached) = read_cache(runtime_url) {
        install(state, &cached, "ogr cache");
    }
    let current = state.compiled.read().unwrap().id.clone();
    match fetch_rules(&state.client, runtime_url, api_key, Some(&current)).await {
        RulesOutcome::Fetched(rs) => install(state, &rs, "ogr fetched"),
        RulesOutcome::NotModified => {
            tracing::info!("ruleset {current} unchanged at the runtime");
            *state.ruleset_source.write().unwrap() = "ogr (served, unchanged)".to_string();
        }
        RulesOutcome::Failed(e) => tracing::warn!("{e}; keeping ruleset {current}"),
    }
}

/// `POST /v1/heartbeat` every `interval`; refetch when the advertised rules id moves.
pub async fn heartbeat_loop(state: Arc<AppState>, runtime_url: String, api_key: String, interval: Duration) {
    let base = runtime_url.trim_end_matches('/').to_string();
    let mut first = true;
    loop {
        if !first {
            tokio::time::sleep(interval).await;
        }
        first = false;
        let ruleset_id = state.compiled.read().unwrap().id.clone();
        let c = state.counters.snapshot();
        let body = serde_json::json!({
            "integration": INTEGRATION,
            "instance_id": state.instance_id,
            "interval_s": interval.as_secs(),
            "ruleset": ruleset_id,
            "counters": {
                "events_sent": c["events_sent"],
                "evaluate_errors": c["evaluate_errors"],
                "unresolved_spans": c["unresolved"],
                "requests": c["requests"],
                "secrets_masked": c["minted"],
            }
        });
        let res = state
            .client
            .post(format!("{base}/v1/heartbeat"))
            .bearer_auth(&api_key)
            .json(&body)
            .timeout(Duration::from_secs(8))
            .send()
            .await;
        let Ok(res) = res else {
            state.ogr_ok.store(false, std::sync::atomic::Ordering::Relaxed);
            continue;
        };
        state.ogr_ok.store(res.status().is_success(), std::sync::atomic::Ordering::Relaxed);
        let Ok(v) = res.json::<serde_json::Value>().await else { continue };
        let advertised = v.get("rules").and_then(|r| r.get("id")).and_then(|i| i.as_str()).map(str::to_string);
        if let Some(id) = advertised {
            if id != ruleset_id {
                match fetch_rules(&state.client, &runtime_url, &api_key, Some(&ruleset_id)).await {
                    RulesOutcome::Fetched(rs) => install(&state, &rs, "ogr fetched"),
                    RulesOutcome::NotModified => {}
                    RulesOutcome::Failed(e) => tracing::warn!("{e}"),
                }
            }
        }
    }
}

/// One-shot check used by `openafw connect`.
pub async fn probe(client: &reqwest::Client, runtime_url: &str, api_key: &str) -> Result<Ruleset> {
    match fetch_rules(client, runtime_url, api_key, None).await {
        RulesOutcome::Fetched(rs) => Ok(rs),
        RulesOutcome::NotModified => read_cache(runtime_url).context("runtime said not-modified but nothing is cached"),
        RulesOutcome::Failed(e) => anyhow::bail!(e),
    }
}


// ---- /v1/evaluate ------------------------------------------------------------------

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct Finding {
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub severity: String,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub detector: Option<String>,
    #[serde(default)]
    pub score: Option<f64>,
    #[serde(default)]
    pub whitelisted: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Span {
    pub path: String,
    pub start: usize,
    pub end: usize,
    pub replacement: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct Modifications {
    #[serde(default)]
    pub spans: Vec<Span>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct Verdict {
    #[serde(default)]
    pub event_id: String,
    pub decision: String,
    #[serde(default)]
    pub findings: Vec<Finding>,
    #[serde(default)]
    pub modifications: Option<Modifications>,
    #[serde(default)]
    pub latency_ms: Option<u64>,
}

impl Verdict {
    pub fn blocked(&self) -> bool {
        self.decision == "block"
    }
    pub fn summary_lines(&self) -> Vec<String> {
        self.findings
            .iter()
            .filter(|f| !f.whitelisted.unwrap_or(false))
            .map(|f| format!("{} {}{}", f.severity, f.category, f.path.as_ref().map(|p| format!(" @{p}")).unwrap_or_default()))
            .collect()
    }
}

/// The wire name OGR uses for a protocol; None = not reportable as raw (Gemini would need the canonical shape).
pub fn llm_protocol(p: afw_engine::Protocol) -> Option<&'static str> {
    match p {
        afw_engine::Protocol::AnthropicMessages => Some("anthropic.messages"),
        afw_engine::Protocol::OpenAiChat => Some("openai.chat"),
        afw_engine::Protocol::OpenAiResponses => Some("openai.responses"),
        _ => None,
    }
}

pub fn now_iso() -> String {
    let d = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default();
    let secs = d.as_secs();
    let ms = d.subsec_millis();
    // civil date from unix seconds (Howard Hinnant's algorithm)
    let days = (secs / 86400) as i64;
    let rem = secs % 86400;
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let dd = doy - (153 * mp + 2) / 5 + 1;
    let mm = if mp < 10 { mp + 3 } else { mp - 9 };
    let yy = if mm <= 2 { y + 1 } else { y };
    format!("{yy:04}-{mm:02}-{dd:02}T{:02}:{:02}:{:02}.{ms:03}Z", rem / 3600, (rem % 3600) / 60, rem % 60)
}

pub fn new_step_id() -> String {
    let mut b = [0u8; 16];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut b);
    hex::encode(b)
}

/// The session the harness stamped on the request, when it did (port of the
/// reference `stampedSession`): OpenAI `user`, Anthropic `metadata.user_id`
/// (Claude Code: a JSON string carrying `session_id`), Codex `prompt_cache_key`.
pub fn stamped_session(body: &serde_json::Value) -> Option<String> {
    fn of_stamp(stamp: &str) -> String {
        let t = stamp.trim();
        if t.starts_with('{') {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(t) {
                if let Some(sid) = v.get("session_id").and_then(|s| s.as_str()) {
                    if !sid.is_empty() {
                        return sid.to_string();
                    }
                }
            }
        }
        if let Some(pos) = t.rfind("session_") {
            let tail = &t[pos + 8..];
            if tail.len() >= 8 && tail.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                return tail.to_string();
            }
        }
        t.to_string()
    }
    let o = body.as_object()?;
    if let Some(u) = o.get("user").and_then(|v| v.as_str()).filter(|u| !u.is_empty()) {
        return Some(of_stamp(u));
    }
    if let Some(uid) = o.get("metadata").and_then(|m| m.get("user_id")).and_then(|v| v.as_str()).filter(|u| !u.is_empty()) {
        return Some(of_stamp(uid));
    }
    o.get("prompt_cache_key").and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(str::to_string)
}

pub struct EventInput<'a> {
    pub kind: &'a str,
    pub step_id: &'a str,
    pub agent: &'a str,
    pub llm_protocol: &'a str,
    pub session_hint: Option<&'a str>,
    pub payload: serde_json::Value,
    pub ruleset: &'a str,
    pub masked: &'a [(String, String)],
}

pub fn build_event(i: EventInput<'_>) -> serde_json::Value {
    let mut ev = serde_json::json!({
        "kind": i.kind,
        "step_id": i.step_id,
        "agent_id": i.agent,
        "agent_type": i.agent,
        "agent_workspace": "",
        "agent_user": "",
        "llm_protocol": i.llm_protocol,
        "integration": INTEGRATION,
        "payload": i.payload,
        "redaction": {
            "ruleset": i.ruleset,
            "masked": i.masked.iter().map(|(t, r)| serde_json::json!({ "token": t, "rule": r })).collect::<Vec<_>>(),
        }
    });
    if let Some(h) = i.session_hint {
        ev["session_hint"] = serde_json::Value::String(h.to_string());
    }
    ev
}

/// `POST /v1/evaluate`. None = no verdict (timeout, error, unparsable): the caller applies fail mode.
pub async fn evaluate(state: &AppState, runtime_url: &str, api_key: &str, event: &serde_json::Value, timeout_ms: u64) -> Option<Verdict> {
    match evaluate_once(state, runtime_url, api_key, event, timeout_ms).await {
        Ok(v) => Some(v),
        Err(EvalError::RedactionShape) if event.get("redaction").is_some() => {
            // A runtime older than OGR's minter-letter schema rejects the
            // `redaction` report's token pattern. The report is a diagnosis
            // only; the step must still be judged, so send it without.
            // (A current runtime accepts `OGRK[0-9A-Z][0-9X]{7,}` and never
            // takes this path — kept for one talking to an older deployment.)
            static WARNED: std::sync::Once = std::sync::Once::new();
            WARNED.call_once(|| tracing::warn!("the runtime rejects the OGRK token shape in `redaction.masked`; reporting steps without the redaction report until it is updated"));
            let mut ev = event.clone();
            ev.as_object_mut().map(|o| o.remove("redaction"));
            evaluate_once(state, runtime_url, api_key, &ev, timeout_ms).await.ok()
        }
        Err(_) => None,
    }
}

enum EvalError {
    RedactionShape,
    Other,
}

async fn evaluate_once(state: &AppState, runtime_url: &str, api_key: &str, event: &serde_json::Value, timeout_ms: u64) -> Result<Verdict, EvalError> {
    let base = runtime_url.trim_end_matches('/');
    state.counters.events_sent.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let res = state
        .client
        .post(format!("{base}/v1/evaluate"))
        .bearer_auth(api_key)
        .json(event)
        .timeout(Duration::from_millis(timeout_ms))
        .send()
        .await;
    let res = match res {
        Ok(r) => r,
        Err(e) => {
            state.counters.evaluate_errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            tracing::warn!("evaluate failed (fail-open): {e}");
            return Err(EvalError::Other);
        }
    };
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().await.unwrap_or_default();
        if status.as_u16() == 400 && body.contains("redaction") && body.contains("invalid_format") {
            return Err(EvalError::RedactionShape);
        }
        state.counters.evaluate_errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        tracing::warn!("evaluate answered {status} (fail-open): {}", body.chars().take(300).collect::<String>());
        return Err(EvalError::Other);
    }
    match res.json::<Verdict>().await {
        Ok(v) => Ok(v),
        Err(e) => {
            state.counters.evaluate_errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            tracing::warn!("evaluate answered an unreadable verdict (fail-open): {e}");
            Err(EvalError::Other)
        }
    }
}

/// Apply `modifications.spans` to a body in place. Paths are dotted
/// (`payload.messages.1.content`), offsets are code points into the leaf.
/// Returns (replacement, original) pairs so the reply can be restored locally.
pub fn apply_spans(body: &mut serde_json::Value, spans: &[Span]) -> Vec<(String, String)> {
    use std::collections::BTreeMap;
    let mut by_path: BTreeMap<&str, Vec<&Span>> = BTreeMap::new();
    for s in spans {
        by_path.entry(s.path.as_str()).or_default().push(s);
    }
    let mut pairs = Vec::new();
    for (path, mut list) in by_path {
        let rel = path.strip_prefix("payload.").unwrap_or(path);
        let Some(leaf) = navigate(body, rel) else { continue };
        let Some(text) = leaf.as_str().map(str::to_string) else { continue };
        let chars: Vec<char> = text.chars().collect();
        list.sort_by(|a, b| b.start.cmp(&a.start));
        let mut out = chars.clone();
        for s in list {
            if s.start > s.end || s.end > out.len() {
                continue;
            }
            let original: String = chars[s.start..s.end.min(chars.len())].iter().collect();
            let repl: Vec<char> = s.replacement.chars().collect();
            out.splice(s.start..s.end, repl);
            if !original.is_empty() {
                pairs.push((s.replacement.clone(), original));
            }
        }
        *leaf = serde_json::Value::String(out.into_iter().collect());
    }
    pairs
}

fn navigate<'a>(v: &'a mut serde_json::Value, rel: &str) -> Option<&'a mut serde_json::Value> {
    let mut cur = v;
    for seg in rel.split('.') {
        cur = match cur {
            serde_json::Value::Object(o) => o.get_mut(seg)?,
            serde_json::Value::Array(a) => a.get_mut(seg.parse::<usize>().ok()?)?,
            _ => return None,
        };
    }
    Some(cur)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn spans_apply_by_code_points_and_report_pairs() {
        let mut b = serde_json::json!({ "messages": [{ "role": "user", "content": "邮箱 ada@acme.io 谢谢" }] });
        let spans = vec![Span { path: "payload.messages.0.content".into(), start: 3, end: 14, replacement: "${OGR_EMAIL_1}".into() }];
        let pairs = apply_spans(&mut b, &spans);
        assert_eq!(b["messages"][0]["content"], "邮箱 ${OGR_EMAIL_1} 谢谢");
        assert_eq!(pairs, vec![("${OGR_EMAIL_1}".to_string(), "ada@acme.io".to_string())]);
    }

    #[test]
    fn session_stamps() {
        assert_eq!(stamped_session(&serde_json::json!({ "metadata": { "user_id": "{\"device_id\":\"d\",\"session_id\":\"abc-123\"}" } })).as_deref(), Some("abc-123"));
        assert_eq!(stamped_session(&serde_json::json!({ "prompt_cache_key": "conv-9" })).as_deref(), Some("conv-9"));
        assert_eq!(stamped_session(&serde_json::json!({ "user": "u_session_abcdefgh" })).as_deref(), Some("abcdefgh"));
        assert_eq!(stamped_session(&serde_json::json!({ "model": "x" })), None);
    }
}
