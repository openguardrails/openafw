//! The local page (design §2): status, agents, activity. Served only on the
//! loopback listener; JSON endpoints under `/__afw/api/*`.

use std::sync::Arc;

use axum::extract::{Query, State};
use axum::response::{Html, IntoResponse};
use axum::Json;
use serde::Deserialize;

use crate::AppState;

const PAGE: &str = include_str!("ui.html");

pub async fn page() -> impl IntoResponse {
    Html(PAGE)
}

pub async fn status(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let compiled = state.compiled.read().unwrap().clone();
    let vault = state.vault.lock().unwrap();
    let agents: Vec<serde_json::Value> = vault
        .data
        .agents
        .iter()
        .map(|a| {
            let p = vault.profile(&a.profile);
            serde_json::json!({
                "agent": a.agent,
                "profile": a.profile,
                "provider": p.map(|p| format!("{:?}", p.provider).to_lowercase()).unwrap_or_default(),
                "base_url": p.map(|p| p.base_url.clone()).unwrap_or_default(),
            })
        })
        .collect();
    let profiles: Vec<serde_json::Value> = vault
        .data
        .profiles
        .iter()
        .map(|p| serde_json::json!({ "name": p.name, "provider": format!("{:?}", p.provider).to_lowercase(), "base_url": p.base_url, "has_key": p.api_key.is_some() }))
        .collect();
    let ogr_connected = vault.data.ogr.is_some();
    drop(vault);
    let map_size = state.engine.lock().unwrap().map.len();
    Json(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "listen": state.args.listen.to_string(),
        "default_upstream": state.args.upstream.clone().unwrap_or_else(|| "per protocol".into()),
        "ruleset": {
            "id": compiled.id,
            "active": compiled.rules.len(),
            "disabled": compiled.disabled.len(),
            "source": *state.ruleset_source.read().unwrap(),
        },
        "ogr": { "connected": ogr_connected, "healthy": state.ogr_ok.load(std::sync::atomic::Ordering::Relaxed) },
        "counters": state.counters.snapshot(),
        "map_size": map_size,
        "uptime_s": state.started.elapsed().as_secs(),
        "paused": state.paused.load(std::sync::atomic::Ordering::Relaxed),
        "agents": agents,
        "profiles": profiles,
    }))
}

#[derive(Deserialize)]
pub struct ActivityQuery {
    limit: Option<usize>,
}

pub async fn activity(State(state): State<Arc<AppState>>, Query(q): Query<ActivityQuery>) -> Json<serde_json::Value> {
    let recent = state.activity.lock().unwrap().recent(q.limit.unwrap_or(50).min(500));
    Json(serde_json::to_value(recent).unwrap())
}

/// Every agent OpenAFW knows about, and whether its config currently routes here.
pub async fn agents(State(state): State<Arc<AppState>>) -> Json<serde_json::Value> {
    let listen = state.args.listen.to_string();
    let vault = state.vault.lock().unwrap();
    let rows: Vec<serde_json::Value> = crate::agents::KNOWN
        .iter()
        .map(|a| {
            let (name, note) = crate::agents::describe(a);
            let route = vault.route_for_agent(a);
            serde_json::json!({
                "agent": a,
                "name": name,
                "note": note,
                "automatable": crate::agents::automatable(a),
                "protection": crate::agents::protection(a, &listen),
                "config_path": crate::agents::config_path(a).map(|p| p.display().to_string()),
                "profile": route.map(|r| r.profile.clone()),
            })
        })
        .collect();
    Json(serde_json::json!({ "agents": rows, "profiles": vault.data.profiles.iter().map(|p| p.name.clone()).collect::<Vec<_>>() }))
}

#[derive(Deserialize)]
pub struct ProtectRequest {
    agent: String,
    #[serde(default)]
    profile: Option<String>,
}

/// Point an agent's own config at OpenAFW (or put it back). The UI's one-click
/// setup — the same code path as `openafw protect`.
pub async fn protect(State(state): State<Arc<AppState>>, Json(req): Json<ProtectRequest>) -> Json<serde_json::Value> {
    let listen = format!("http://{}", state.args.listen);
    let mut vault = state.vault.lock().unwrap();
    let token = match &req.profile {
        Some(p) if !p.is_empty() => match vault.set_agent(&req.agent, p) {
            Ok(t) => Some(t),
            Err(e) => return Json(serde_json::json!({ "ok": false, "error": e.to_string() })),
        },
        _ => None,
    };
    let provider = vault.route_for_agent(&req.agent).map(|r| r.profile.clone()).and_then(|n| vault.profile(&n).map(|p| p.provider));
    let out = crate::agents::protect(&mut vault, &req.agent, &listen, token.as_deref(), provider);
    let saved = vault.save();
    match (out, saved) {
        (Ok(msg), Ok(())) => {
            tracing::info!("protect {}: {}", req.agent, msg.replace('\n', " "));
            Json(serde_json::json!({ "ok": true, "message": msg }))
        }
        (Err(e), _) | (_, Err(e)) => Json(serde_json::json!({ "ok": false, "error": format!("{e:#}") })),
    }
}

#[derive(Deserialize)]
pub struct UnprotectRequest {
    agent: String,
}

pub async fn unprotect(State(state): State<Arc<AppState>>, Json(req): Json<UnprotectRequest>) -> Json<serde_json::Value> {
    let mut vault = state.vault.lock().unwrap();
    let out = crate::agents::unprotect(&mut vault, &req.agent);
    let saved = vault.save();
    match (out, saved) {
        (Ok(msg), Ok(())) => {
            tracing::info!("unprotect {}: {}", req.agent, msg);
            Json(serde_json::json!({ "ok": true, "message": msg }))
        }
        (Err(e), _) | (_, Err(e)) => Json(serde_json::json!({ "ok": false, "error": format!("{e:#}") })),
    }
}
