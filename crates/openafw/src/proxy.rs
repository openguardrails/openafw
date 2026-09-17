//! The pass-through proxy. The only change to a request body is string-leaf
//! masking (plus the optional placeholder hint); the only change to a
//! response is string-leaf restoration. SSE is rewritten frame by frame;
//! everything else is forwarded byte for byte.

use std::sync::Arc;
use std::time::Instant;

use afw_engine::{mask_value_cached, restore_value, tokens_present, Protocol, RestoreKeys, Stream};
use axum::body::{Body, Bytes};
use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, Request, Response, StatusCode};
use axum::routing::{any, get};
use axum::Router;
use futures_util::StreamExt;

use crate::activity::{now_ms, Record};
use crate::vault::{is_local_token, Provider};
use crate::{ui, AppState};

pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        .route("/__afw/health", any(health))
        .route("/__afw/", get(ui::page))
        .route("/__afw", get(ui::page))
        .route("/__afw/api/status", get(ui::status))
        .route("/__afw/api/activity", get(ui::activity))
        .route("/__afw/api/mask", axum::routing::post(mask_endpoint))
        .route("/__afw/api/pause", axum::routing::post(pause_endpoint))
        .route("/__afw/api/agents", get(ui::agents))
        .route("/__afw/api/protect", axum::routing::post(ui::protect))
        .route("/__afw/api/unprotect", axum::routing::post(ui::unprotect))
        .fallback(any(handle))
        .with_state(state)
}

async fn health() -> &'static str {
    "ok"
}

#[derive(serde::Deserialize)]
struct PauseRequest {
    paused: bool,
}

/// Pause = requests pass through UNMASKED. A debugging state, never the default.
async fn pause_endpoint(State(state): State<Arc<AppState>>, axum::Json(req): axum::Json<PauseRequest>) -> axum::Json<serde_json::Value> {
    state.paused.store(req.paused, std::sync::atomic::Ordering::Relaxed);
    if req.paused {
        tracing::warn!("PAUSED: requests now pass through unmasked");
    } else {
        tracing::info!("resumed: masking on");
    }
    axum::Json(serde_json::json!({ "paused": req.paused }))
}

#[derive(serde::Deserialize)]
struct MaskRequest {
    /// A text or a JSON value; every string leaf is masked.
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    value: Option<serde_json::Value>,
}

/// The loopback MINT endpoint for other local processes (plugins, hooks):
/// value → token, mint-or-lookup, through the same map and rules the proxy
/// uses. There is deliberately NO token → value endpoint: restoration happens
/// only inside the process that already holds the reply, or a restore
/// endpoint would hand every local process the plaintext of everything seen.
async fn mask_endpoint(State(state): State<Arc<AppState>>, axum::Json(req): axum::Json<MaskRequest>) -> axum::Json<serde_json::Value> {
    let compiled = state.compiled.read().unwrap().clone();
    let (value, report) = {
        let mut engine = state.engine.lock().unwrap();
        let engine = &mut *engine;
        let mut v = match (req.text, req.value) {
            (Some(t), _) => serde_json::Value::String(t),
            (None, Some(v)) => v,
            (None, None) => serde_json::Value::String(String::new()),
        };
        let report = mask_value_cached(&mut v, &mut engine.map, Some(&compiled), &mut engine.cache);
        (v, report)
    };
    if !report.minted.is_empty() {
        let entries: Vec<(String, String)> = {
            let engine = state.engine.lock().unwrap();
            engine.map.entries().map(|(t, v)| (t.to_string(), v.to_string())).collect()
        };
        let mut vault = state.vault.lock().unwrap();
        vault.data.map = entries;
        if let Err(e) = vault.save() {
            tracing::error!("vault not saved: {e:#}");
        }
    }
    let minted: Vec<serde_json::Value> = report.minted.iter().map(|m| serde_json::json!({ "token": m.token, "rule": m.rule })).collect();
    let out = match value {
        serde_json::Value::String(t) => serde_json::json!({ "text": t, "minted": minted, "known": report.known, "ruleset": compiled.id }),
        v => serde_json::json!({ "value": v, "minted": minted, "known": report.known, "ruleset": compiled.id }),
    };
    axum::Json(out)
}

/// Hop-by-hop and framing headers that must not be copied either way.
const DROP: &[&str] = &[
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
    "keep-alive",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
    "accept-encoding",
    "content-encoding",
];

fn copy_headers(from: &HeaderMap, to: &mut HeaderMap) {
    for (k, v) in from {
        if DROP.contains(&k.as_str()) {
            continue;
        }
        to.append(k.clone(), v.clone());
    }
}

/// The text appended to the system prompt when a request carries placeholders.
pub const PLACEHOLDER_HINT: &str = "Note from the user's local secrets firewall (OpenAFW): strings of the form OGRKFnnnnnnn are opaque placeholders for real credentials. Use them exactly as written wherever the credential is needed (commands, files, requests); do not alter, expand, shorten, or reconstruct them, and do not treat them as shell variables. They are restored to the real values on the user's machine automatically.";

/// The credential the agent presented: header/query it came in, and the value.
struct Credential {
    value: String,
}

fn incoming_credential(headers: &HeaderMap, query: Option<&str>) -> Option<Credential> {
    if let Some(v) = headers.get("x-api-key").and_then(|v| v.to_str().ok()) {
        return Some(Credential { value: v.to_string() });
    }
    if let Some(v) = headers.get("x-goog-api-key").and_then(|v| v.to_str().ok()) {
        return Some(Credential { value: v.to_string() });
    }
    if let Some(v) = headers.get(header::AUTHORIZATION).and_then(|v| v.to_str().ok()) {
        let v = v.strip_prefix("Bearer ").or_else(|| v.strip_prefix("bearer ")).unwrap_or(v);
        return Some(Credential { value: v.to_string() });
    }
    if let Some(q) = query {
        for pair in q.split('&') {
            if let Some(v) = pair.strip_prefix("key=") {
                return Some(Credential { value: v.to_string() });
            }
        }
    }
    None
}

fn strip_key_query(query: Option<&str>) -> Option<String> {
    let q = query?;
    let kept: Vec<&str> = q.split('&').filter(|p| !p.starts_with("key=")).collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join("&"))
    }
}

/// Where this request goes and with what credential.
struct Route {
    agent: String,
    base_url: String,
    provider: Provider,
    /// Some = replace the agent's credential with this; None = pass through.
    key: Option<String>,
}

fn resolve_route(state: &AppState, cred: Option<&Credential>, protocol: Protocol) -> Route {
    if let Some(c) = cred {
        if is_local_token(&c.value) {
            let vault = state.vault.lock().unwrap();
            if let Some((route, profile)) = vault.route_for_token(&c.value) {
                return Route {
                    agent: route.agent.clone(),
                    base_url: profile.base_url.clone(),
                    provider: profile.provider,
                    key: profile.api_key.clone(),
                };
            }
        }
    }
    let provider = match protocol {
        Protocol::AnthropicMessages => Provider::Anthropic,
        Protocol::Gemini => Provider::Gemini,
        Protocol::OpenAiChat | Protocol::OpenAiResponses => Provider::Openai,
        Protocol::Unknown => Provider::OpenaiCompatible,
    };
    // Pass-through: the agent keeps its own credentials, so the request goes
    // where those credentials are valid — the protocol's official endpoint —
    // unless one relay was configured for everything.
    let base_url = match &state.args.upstream {
        Some(u) => u.clone(),
        None => {
            let d = provider.default_base_url();
            if d.is_empty() { Provider::Anthropic.default_base_url().to_string() } else { d.to_string() }
        }
    };
    Route { agent: "default".into(), base_url, provider, key: state.args.upstream_key.clone() }
}

fn apply_credential(headers: &mut HeaderMap, provider: Provider, protocol: Protocol, key: &str) -> anyhow::Result<()> {
    headers.remove(header::AUTHORIZATION);
    headers.remove(HeaderName::from_static("x-api-key"));
    headers.remove(HeaderName::from_static("x-goog-api-key"));
    match (provider, protocol) {
        (Provider::Anthropic, _) | (_, Protocol::AnthropicMessages) => {
            headers.insert(HeaderName::from_static("x-api-key"), HeaderValue::from_str(key)?);
        }
        (Provider::Gemini, _) | (_, Protocol::Gemini) => {
            headers.insert(HeaderName::from_static("x-goog-api-key"), HeaderValue::from_str(key)?);
        }
        _ => {
            headers.insert(header::AUTHORIZATION, HeaderValue::from_str(&format!("Bearer {key}"))?);
        }
    }
    Ok(())
}

/// Append the placeholder hint to the request's system prompt, per protocol.
fn inject_hint(body: &mut serde_json::Value, protocol: Protocol) {
    use serde_json::{json, Value};
    let obj = match body.as_object_mut() {
        Some(o) => o,
        None => return,
    };
    match protocol {
        Protocol::AnthropicMessages => match obj.get_mut("system") {
            Some(Value::String(s)) => {
                s.push_str("\n\n");
                s.push_str(PLACEHOLDER_HINT);
            }
            Some(Value::Array(blocks)) => blocks.push(json!({ "type": "text", "text": PLACEHOLDER_HINT })),
            _ => {
                obj.insert("system".into(), Value::String(PLACEHOLDER_HINT.into()));
            }
        },
        Protocol::OpenAiChat => {
            if let Some(Value::Array(msgs)) = obj.get_mut("messages") {
                let first_is_system = msgs
                    .first()
                    .and_then(|m| m.get("role"))
                    .and_then(Value::as_str)
                    .map(|r| r == "system" || r == "developer")
                    .unwrap_or(false);
                if first_is_system {
                    if let Some(Value::String(c)) = msgs[0].get_mut("content") {
                        c.push_str("\n\n");
                        c.push_str(PLACEHOLDER_HINT);
                        return;
                    }
                    if let Some(Value::Array(parts)) = msgs[0].get_mut("content") {
                        parts.push(json!({ "type": "text", "text": PLACEHOLDER_HINT }));
                        return;
                    }
                }
                msgs.insert(0, json!({ "role": "system", "content": PLACEHOLDER_HINT }));
            }
        }
        Protocol::OpenAiResponses => match obj.get_mut("instructions") {
            Some(Value::String(s)) => {
                s.push_str("\n\n");
                s.push_str(PLACEHOLDER_HINT);
            }
            _ => {
                obj.insert("instructions".into(), Value::String(PLACEHOLDER_HINT.into()));
            }
        },
        Protocol::Gemini => {
            let si = obj.entry("systemInstruction").or_insert_with(|| json!({ "parts": [] }));
            if let Some(Value::Array(parts)) = si.get_mut("parts") {
                parts.push(json!({ "text": PLACEHOLDER_HINT }));
            }
        }
        Protocol::Unknown => {}
    }
}

async fn handle(State(state): State<Arc<AppState>>, req: Request<Body>) -> Response<Body> {
    match forward(state.clone(), req).await {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("proxy error: {e:#}");
            let msg = serde_json::to_string(&e.to_string()).unwrap();
            state.counters.errors.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!("{{\"type\":\"error\",\"error\":{{\"type\":\"openafw_error\",\"message\":{msg}}}}}")))
                .unwrap()
        }
    }
}

fn join_upstream(base_url: &str, path: &str, query: Option<&str>) -> String {
    let base = base_url.trim_end_matches('/');
    // A relay base_url that already ends in /v1 meets an agent path that starts with /v1.
    let path = if base.ends_with("/v1") && path.starts_with("/v1/") { &path[3..] } else { path };
    match query {
        Some(q) => format!("{base}{path}?{q}"),
        None => format!("{base}{path}"),
    }
}

/// A provider-shaped error body for a refused step.
fn blocked_body(protocol: Protocol, why: &str) -> (StatusCode, String) {
    let msg = format!("Blocked by OpenGuardrails via OpenAFW: {why}");
    let body = match protocol {
        Protocol::AnthropicMessages => serde_json::json!({ "type": "error", "error": { "type": "permission_error", "message": msg } }),
        Protocol::Gemini => serde_json::json!({ "error": { "code": 403, "status": "PERMISSION_DENIED", "message": msg } }),
        _ => serde_json::json!({ "error": { "message": msg, "type": "invalid_request_error", "code": "openafw_blocked" } }),
    };
    (StatusCode::FORBIDDEN, body.to_string())
}

/// The same refusal as a terminal SSE frame, for a held stream.
fn blocked_frame(protocol: Protocol, why: &str) -> String {
    let (_, body) = blocked_body(protocol, why);
    match protocol {
        Protocol::AnthropicMessages => format!("event: error\ndata: {body}\n\n"),
        Protocol::OpenAiResponses => format!("event: error\ndata: {body}\n\n"),
        _ => format!("data: {body}\n\ndata: [DONE]\n\n"),
    }
}

fn decision_summary(v: &crate::ogr::Verdict, enforced: bool) -> crate::activity::OgrDecision {
    crate::activity::OgrDecision { decision: v.decision.clone(), enforced, findings: v.summary_lines(), event_id: v.event_id.clone() }
}

async fn forward(state: Arc<AppState>, req: Request<Body>) -> anyhow::Result<Response<Body>> {
    let started = Instant::now();
    let (parts, body) = req.into_parts();
    let path = parts.uri.path().to_string();
    if path.starts_with("/__afw/") || path == "/__afw" {
        return Ok(Response::builder().status(StatusCode::NOT_FOUND).body(Body::from("no such openafw endpoint"))?);
    }
    let query = parts.uri.query().map(str::to_string);
    let protocol = Protocol::from_path(&path);
    let body = axum::body::to_bytes(body, 64 * 1024 * 1024).await?;

    let cred = incoming_credential(&parts.headers, query.as_deref());
    let route = resolve_route(&state, cred.as_ref(), protocol);
    let ogr = state.ogr.clone();
    let ogr_proto = crate::ogr::llm_protocol(protocol);
    let enforce = state.args.ogr_enforce;
    let step_id = crate::ogr::new_step_id();
    let ruleset_id = state.compiled.read().unwrap().id.clone();

    // ---- request: mask every string leaf ---------------------------------------
    let mut record = Record {
        id: crate::activity::next_id(),
        at: now_ms(),
        agent: route.agent.clone(),
        protocol: format!("{protocol:?}").to_lowercase(),
        path: path.clone(),
        model: String::new(),
        status: 0,
        streamed: false,
        minted: Vec::new(),
        known: 0,
        tokens_in_context: 0,
        restored: 0,
        unresolved: Vec::new(),
        ms: 0,
        error: None,
        ogr: None,
    };
    let mut span_pairs: Vec<(String, String)> = Vec::new();
    let mut session_hint: Option<String> = None;
    let (out_body, allowed): (Bytes, Vec<String>) = match serde_json::from_slice::<serde_json::Value>(&body) {
        Ok(mut json) if json.is_object() && parts.method == Method::POST && state.args.mask && !state.paused.load(std::sync::atomic::Ordering::Relaxed) => {
            record.model = json.get("model").and_then(|m| m.as_str()).unwrap_or("").to_string();
            session_hint = crate::ogr::stamped_session(&json);
            let compiled = state.compiled.read().unwrap().clone();
            let report = {
                let mut engine = state.engine.lock().unwrap();
                let raw = String::from_utf8_lossy(&body);
                engine.map.seed_above(afw_engine::mask::highest_secret_number(&raw));
                let engine = &mut *engine;
                mask_value_cached(&mut json, &mut engine.map, Some(&compiled), &mut engine.cache)
            };
            if !report.minted.is_empty() {
                // Persist the grown map (design §5.3). Values only ever live encrypted.
                let entries: Vec<(String, String)> = {
                    let engine = state.engine.lock().unwrap();
                    engine.map.entries().map(|(t, v)| (t.to_string(), v.to_string())).collect()
                };
                let mut vault = state.vault.lock().unwrap();
                vault.data.map = entries;
                if let Err(e) = vault.save() {
                    tracing::error!("vault not saved: {e:#}");
                }
            }
            let has_tokens = !tokens_present(&serde_json::to_string(&json)?).is_empty();
            if has_tokens && state.args.hint {
                inject_hint(&mut json, protocol);
            }
            record.minted = report.minted.iter().map(|m| format!("{}={}", m.token, m.rule)).collect();
            record.known = report.known;

            // ---- OGR step/request: judged on the MASKED body -------------------------
            if let (Some(conn), Some(lp)) = (&ogr, ogr_proto) {
                let mut payload = json.clone();
                payload["timing"] = serde_json::json!({ "received_at": crate::ogr::now_iso() });
                let masked: Vec<(String, String)> = report.minted.iter().map(|m| (m.token.clone(), m.rule.clone())).collect();
                let event = crate::ogr::build_event(crate::ogr::EventInput {
                    kind: "step/request",
                    step_id: &step_id,
                    agent: &route.agent,
                    llm_protocol: lp,
                    session_hint: session_hint.as_deref(),
                    payload,
                    ruleset: &ruleset_id,
                    masked: &masked,
                });
                match crate::ogr::evaluate(&state, &conn.runtime_url, &conn.api_key, &event, state.args.ogr_timeout_ms).await {
                    Some(v) => {
                        let blocked = v.blocked();
                        let mut summary = crate::activity::OgrSummary::default();
                        summary.request = Some(decision_summary(&v, enforce));
                        if let Some(m) = &v.modifications {
                            if !m.spans.is_empty() {
                                span_pairs = crate::ogr::apply_spans(&mut json, &m.spans);
                                tracing::info!("step/request: {} span(s) applied from the runtime", span_pairs.len());
                            }
                        }
                        record.ogr = Some(summary);
                        if blocked {
                            tracing::warn!("step/request BLOCKED by OpenGuardrails ({}): {:?}", if enforce { "enforced" } else { "observe only" }, v.summary_lines());
                            if enforce {
                                state.counters.blocked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                let (status, text) = blocked_body(protocol, &v.summary_lines().join("; "));
                                record.status = status.as_u16();
                                record.ms = started.elapsed().as_millis() as u64;
                                state.counters.add(&record);
                                state.activity.lock().unwrap().push(record);
                                return Ok(Response::builder().status(status).header(header::CONTENT_TYPE, "application/json").body(Body::from(text))?);
                            }
                        }
                    }
                    None => {
                        record.ogr = Some(crate::activity::OgrSummary { unjudged: true, ..Default::default() });
                    }
                }
            }

            let text = serde_json::to_string(&json)?;
            let allowed = tokens_present(&text);
            record.tokens_in_context = allowed.len();
            if report.changed {
                tracing::info!(
                    "mask {} {} [{}]: {} minted [{}], {} known occurrences, {} tokens in context",
                    parts.method,
                    path,
                    route.agent,
                    report.minted.len(),
                    record.minted.join(" "),
                    report.known,
                    allowed.len()
                );
            }
            (Bytes::from(text), allowed)
        }
        _ => (body, Vec::new()),
    };

    if let Some(dir) = &state.args.tap {
        let _ = std::fs::create_dir_all(dir);
        let name = format!("{}-{}.json", now_ms(), path.trim_start_matches('/').replace('/', "_"));
        if let Err(e) = std::fs::write(dir.join(name), &out_body) {
            tracing::warn!("tap not written: {e}");
        }
    }

    // ---- forward ---------------------------------------------------------------
    let mut headers = HeaderMap::new();
    copy_headers(&parts.headers, &mut headers);
    headers.insert(header::ACCEPT_ENCODING, HeaderValue::from_static("identity"));
    let mut out_query = query.clone();
    if let Some(key) = &route.key {
        apply_credential(&mut headers, route.provider, protocol, key)?;
        out_query = strip_key_query(query.as_deref());
    }
    let url = join_upstream(&route.base_url, &path, out_query.as_deref());
    let method = reqwest::Method::from_bytes(parts.method.as_str().as_bytes())?;
    let upstream = state.client.request(method, &url).headers(headers).body(out_body).send().await?;

    let status = upstream.status();
    record.status = status.as_u16();
    let mut resp = Response::builder().status(status.as_u16());
    copy_headers(upstream.headers(), resp.headers_mut().unwrap());
    let is_sse = upstream
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.starts_with("text/event-stream"))
        .unwrap_or(false);

    // ---- response: restore every string leaf ------------------------------------
    let keys: RestoreKeys = {
        let engine = state.engine.lock().unwrap();
        let mut k = engine.map.restore_keys(allowed.iter().map(String::as_str));
        for (token, value) in &span_pairs {
            k.insert(token, value);
        }
        k.freeze()
    };
    let report_step = ogr.is_some() && ogr_proto.is_some() && status.is_success();

    if is_sse {
        record.streamed = true;
        let keys = Arc::new(keys);
        let mut upstream_stream = upstream.bytes_stream();
        let st = state.clone();
        let agent = route.agent.clone();
        let step_id_c = step_id.clone();
        let ruleset_c = ruleset_id.clone();
        let hint_c = session_hint.clone();

        if report_step && enforce {
            // Bounded head = 0: hold the whole reply, judge once, then release or refuse.
            let mut raw: Vec<u8> = Vec::new();
            while let Some(chunk) = upstream_stream.next().await {
                raw.extend_from_slice(&chunk?);
            }
            let text = String::from_utf8_lossy(&raw).into_owned();
            let mut re = afw_engine::Reassembler::new(protocol);
            re.feed(&text);
            let reassembled = re.finish();
            let conn = ogr.as_ref().unwrap();
            let verdict = match (reassembled, ogr_proto) {
                (Some(mut payload), Some(lp)) => {
                    payload["timing"] = serde_json::json!({ "completed_at": crate::ogr::now_iso() });
                    let event = crate::ogr::build_event(crate::ogr::EventInput { kind: "step/response", step_id: &step_id, agent: &agent, llm_protocol: lp, session_hint: hint_c.as_deref(), payload, ruleset: &ruleset_c, masked: &[] });
                    crate::ogr::evaluate(&state, &conn.runtime_url, &conn.api_key, &event, state.args.ogr_timeout_ms).await
                }
                _ => None,
            };
            let mut summary = record.ogr.take().unwrap_or_default();
            let mut out = String::new();
            match verdict {
                Some(v) if v.blocked() => {
                    state.counters.blocked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    tracing::warn!("step/response BLOCKED by OpenGuardrails (enforced): {:?}", v.summary_lines());
                    summary.response = Some(decision_summary(&v, true));
                    out = blocked_frame(protocol, &v.summary_lines().join("; "));
                }
                other => {
                    if let Some(v) = &other {
                        summary.response = Some(decision_summary(v, true));
                    } else {
                        summary.unjudged = true;
                    }
                    let mut restorer = Stream::new(protocol, &keys);
                    out.push_str(&restorer.feed(&text));
                    out.push_str(&restorer.end());
                    let rep = restorer.report();
                    record.restored = rep.restored;
                    record.unresolved = rep.unresolved;
                }
            }
            record.ogr = Some(summary);
            record.ms = started.elapsed().as_millis() as u64;
            state.counters.add(&record);
            state.activity.lock().unwrap().push(record);
            return Ok(resp.body(Body::from(out))?);
        }

        let stream = async_stream::stream! {
            let keys = keys.clone();
            let mut restorer = Stream::new(protocol, &keys);
            let inert = restorer.inert();
            let mut reassembler = if report_step { Some(afw_engine::Reassembler::new(protocol)) } else { None };
            let mut carry: Vec<u8> = Vec::new();
            let mut record = record;
            while let Some(chunk) = upstream_stream.next().await {
                match chunk {
                    Ok(bytes) => {
                        if inert && reassembler.is_none() {
                            yield Ok::<Bytes, std::io::Error>(bytes);
                            continue;
                        }
                        carry.extend_from_slice(&bytes);
                        let valid = match std::str::from_utf8(&carry) {
                            Ok(_) => carry.len(),
                            Err(e) => e.valid_up_to(),
                        };
                        let text = String::from_utf8_lossy(&carry[..valid]).into_owned();
                        carry.drain(..valid);
                        if let Some(r) = reassembler.as_mut() { r.feed(&text); }
                        let out = if inert { text } else { restorer.feed(&text) };
                        if !out.is_empty() {
                            yield Ok(Bytes::from(out));
                        }
                    }
                    Err(e) => {
                        record.error = Some(e.to_string());
                        yield Err(std::io::Error::new(std::io::ErrorKind::Other, e));
                        break;
                    }
                }
            }
            if !carry.is_empty() {
                let text = String::from_utf8_lossy(&carry).into_owned();
                if let Some(r) = reassembler.as_mut() { r.feed(&text); }
                let out = if inert { text } else { restorer.feed(&text) };
                if !out.is_empty() { yield Ok(Bytes::from(out)); }
            }
            if !inert {
                let tail = restorer.end();
                if !tail.is_empty() { yield Ok(Bytes::from(tail)); }
                let report = restorer.report();
                record.restored = report.restored;
                record.unresolved = report.unresolved;
            }
            record.ms = started.elapsed().as_millis() as u64;
            if record.restored > 0 || !record.unresolved.is_empty() {
                tracing::info!("restore (stream) {} [{}]: {} deltas restored, unresolved {:?}, {} ms",
                    record.path, record.agent, record.restored, record.unresolved, record.ms);
            }
            let record_id = record.id;
            st.counters.add(&record);
            st.activity.lock().unwrap().push(record);
            // Observe-only: judge the reassembled reply after it was delivered, then annotate the record.
            if let (Some(re), Some(conn), Some(lp)) = (reassembler, st.ogr.clone(), ogr_proto) {
                if let Some(mut payload) = re.finish() {
                    payload["timing"] = serde_json::json!({ "completed_at": crate::ogr::now_iso() });
                    let st2 = st.clone();
                    let event = crate::ogr::build_event(crate::ogr::EventInput { kind: "step/response", step_id: &step_id_c, agent: &agent, llm_protocol: lp, session_hint: hint_c.as_deref(), payload, ruleset: &ruleset_c, masked: &[] });
                    tokio::spawn(async move {
                        let v = crate::ogr::evaluate(&st2, &conn.runtime_url, &conn.api_key, &event, st2.args.ogr_timeout_ms).await;
                        st2.activity.lock().unwrap().update(record_id, |r| {
                            let mut s = r.ogr.take().unwrap_or_default();
                            match &v {
                                Some(v) => {
                                    if v.blocked() { tracing::warn!("step/response would be BLOCKED by OpenGuardrails (observe only): {:?}", v.summary_lines()); }
                                    s.response = Some(decision_summary(v, false));
                                }
                                None => s.unjudged = true,
                            }
                            r.ogr = Some(s);
                        });
                    });
                }
            }
        };
        return Ok(resp.body(Body::from_stream(stream))?);
    }

    let bytes = upstream.bytes().await?;
    // ---- OGR step/response on a whole body (masked form, before restoration) ----------
    if report_step {
        if let (Ok(mut payload), Some(conn), Some(lp)) = (serde_json::from_slice::<serde_json::Value>(&bytes), ogr.as_ref(), ogr_proto) {
            if payload.is_object() {
                payload["timing"] = serde_json::json!({ "completed_at": crate::ogr::now_iso() });
                let event = crate::ogr::build_event(crate::ogr::EventInput { kind: "step/response", step_id: &step_id, agent: &route.agent, llm_protocol: lp, session_hint: session_hint.as_deref(), payload, ruleset: &ruleset_id, masked: &[] });
                let v = crate::ogr::evaluate(&state, &conn.runtime_url, &conn.api_key, &event, state.args.ogr_timeout_ms).await;
                let mut summary = record.ogr.take().unwrap_or_default();
                match &v {
                    Some(v) => summary.response = Some(decision_summary(v, enforce)),
                    None => summary.unjudged = true,
                }
                record.ogr = Some(summary);
                if let Some(v) = v {
                    if v.blocked() {
                        tracing::warn!("step/response BLOCKED by OpenGuardrails ({}): {:?}", if enforce { "enforced" } else { "observe only" }, v.summary_lines());
                        if enforce {
                            state.counters.blocked.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                            let (status, text) = blocked_body(protocol, &v.summary_lines().join("; "));
                            record.status = status.as_u16();
                            record.ms = started.elapsed().as_millis() as u64;
                            state.counters.add(&record);
                            state.activity.lock().unwrap().push(record);
                            return Ok(Response::builder().status(status).header(header::CONTENT_TYPE, "application/json").body(Body::from(text))?);
                        }
                    }
                }
            }
        }
    }
    let out = if keys.is_empty() {
        bytes
    } else {
        match serde_json::from_slice::<serde_json::Value>(&bytes) {
            Ok(mut json) => {
                let report = restore_value(&mut json, &keys);
                record.restored = report.restored;
                record.unresolved = report.unresolved;
                if report.changed {
                    Bytes::from(serde_json::to_vec(&json)?)
                } else {
                    bytes
                }
            }
            Err(_) => bytes,
        }
    };
    record.ms = started.elapsed().as_millis() as u64;
    if record.restored > 0 || !record.unresolved.is_empty() {
        tracing::info!("restore {} [{}]: {} restored, unresolved {:?}, {} ms", path, route.agent, record.restored, record.unresolved, record.ms);
    }
    state.counters.add(&record);
    state.activity.lock().unwrap().push(record);
    Ok(resp.body(Body::from(out))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn upstream_join_dedups_v1() {
        assert_eq!(join_upstream("https://relay.example/v1", "/v1/responses", None), "https://relay.example/v1/responses");
        assert_eq!(join_upstream("https://api.openai.com", "/v1/responses", Some("a=1")), "https://api.openai.com/v1/responses?a=1");
        assert_eq!(join_upstream("https://api.anthropic.com/", "/v1/messages", None), "https://api.anthropic.com/v1/messages");
    }

    #[test]
    fn hint_lands_in_the_system_prompt() {
        let mut b = serde_json::json!({ "system": "be nice", "messages": [] });
        inject_hint(&mut b, Protocol::AnthropicMessages);
        assert!(b["system"].as_str().unwrap().ends_with(PLACEHOLDER_HINT));
        let mut b = serde_json::json!({ "messages": [{ "role": "user", "content": "hi" }] });
        inject_hint(&mut b, Protocol::OpenAiChat);
        assert_eq!(b["messages"][0]["role"], "system");
        let mut b = serde_json::json!({ "contents": [] });
        inject_hint(&mut b, Protocol::Gemini);
        assert_eq!(b["systemInstruction"]["parts"][0]["text"], PLACEHOLDER_HINT);
    }
}
