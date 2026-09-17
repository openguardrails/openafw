//! OpenAFW core — the daemon (proxy, engine state, vault, OGR client) as a
//! library, so the CLI and the desktop shell run the same code in-process.

pub mod activity;
pub mod agents;
pub mod ogr;
pub mod proxy;
pub mod service;
pub mod ui;
pub mod vault;

use std::net::SocketAddr;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use afw_engine::{compile, CompiledRuleset, MaskCache, Ruleset, SessionMap, DEFAULT_TIERS};
use anyhow::{bail, Result};
use clap::Parser;

pub use vault::{Profile, Provider, Vault};

#[derive(Parser, Debug, Clone)]
pub struct ServeArgs {
    /// Address to listen on. Loopback only by design.
    #[arg(long, env = "AFW_LISTEN", default_value = "127.0.0.1:4141", global = true)]
    pub listen: SocketAddr,

    /// Upstream for requests that carry the agent's own credentials (pass-through).
    /// Unset = the official endpoint of whatever protocol the request speaks
    /// (Anthropic, OpenAI, Gemini); set it to send every pass-through request to one relay.
    #[arg(long, env = "AFW_UPSTREAM")]
    pub upstream: Option<String>,

    /// Key for the default upstream (replaces the agent's credential). Prefer profiles.
    #[arg(long, env = "AFW_UPSTREAM_KEY")]
    pub upstream_key: Option<String>,

    /// Ruleset JSON (`GET /v1/rules` shape) overriding the bundled snapshot and the OGR feed.
    #[arg(long, env = "AFW_RULES")]
    pub rules: Option<std::path::PathBuf>,

    /// Skip the heuristic tier (password assignments and the like).
    #[arg(long, env = "AFW_STRONG_ONLY", default_value_t = false)]
    pub strong_only: bool,

    /// Mask secrets (default on). `--mask false` is a demonstration mode: bodies go upstream untouched.
    #[arg(long, env = "AFW_MASK", default_value_t = true, action = clap::ArgAction::Set)]
    pub mask: bool,

    /// Debug: write every OUTBOUND request body (what the provider receives) to this directory.
    #[arg(long, env = "AFW_TAP")]
    pub tap: Option<std::path::PathBuf>,

    /// With an OpenGuardrails connection: enforce `block` verdicts (refuse the model call /
    /// hold a streamed reply and refuse it). Default: observe only — verdicts and findings are
    /// recorded on the activity page, nothing is refused.
    #[arg(long, env = "AFW_OGR_ENFORCE", default_value_t = false)]
    pub ogr_enforce: bool,

    /// Budget for one `/v1/evaluate` round trip; past it the step goes unjudged (fail-open).
    #[arg(long, env = "AFW_OGR_TIMEOUT_MS", default_value_t = 4000)]
    pub ogr_timeout_ms: u64,

    /// Append a note to the system prompt explaining placeholders when a request carries any.
    /// Off by default: the `OGRKnnnnnnnn` shape was measured to need none.
    #[arg(long, env = "AFW_HINT", default_value_t = false, action = clap::ArgAction::Set)]
    pub hint: bool,
}

pub struct Engine {
    pub map: SessionMap,
    pub cache: MaskCache,
}

pub struct AppState {
    pub args: ServeArgs,
    pub compiled: RwLock<Arc<CompiledRuleset>>,
    pub ruleset_source: RwLock<String>,
    pub engine: Mutex<Engine>,
    pub vault: Mutex<Vault>,
    pub client: reqwest::Client,
    pub activity: Mutex<activity::Log>,
    pub counters: activity::Counters,
    pub started: Instant,
    pub instance_id: String,
    pub ogr_ok: AtomicBool,
    /// The OpenGuardrails connection captured at start (None = free mode).
    pub ogr: Option<vault::OgrConnection>,
    /// Paused = every request passes through UNMASKED (a debugging state; loud in the UI).
    pub paused: AtomicBool,
}

impl AppState {
    pub fn tiers(&self) -> &'static [&'static str] {
        if self.args.strong_only {
            &["strong"]
        } else {
            DEFAULT_TIERS
        }
    }
}

pub fn open_vault() -> Result<Vault> {
    let mut notes = Vec::new();
    let v = Vault::open(&mut notes)?;
    for n in notes {
        eprintln!("openafw: {n}");
    }
    Ok(v)
}

pub async fn build_state(args: ServeArgs) -> Result<Arc<AppState>> {
    if !args.listen.ip().is_loopback() {
        bail!("refusing to listen on a non-loopback address ({}): OpenAFW is a local firewall", args.listen);
    }
    let vault = open_vault()?;

    // Ruleset precedence: --rules file > OGR feed (cache, then fetch) > bundled snapshot.
    let (ruleset, source) = match &args.rules {
        Some(path) => (Ruleset::from_json(&std::fs::read_to_string(path)?).map_err(anyhow::Error::msg)?, format!("file {}", path.display())),
        None => (afw_engine::builtin_ruleset(), "bundled".to_string()),
    };
    let tiers: &[&str] = if args.strong_only { &["strong"] } else { DEFAULT_TIERS };
    let compiled = compile(&ruleset, tiers);
    for d in &compiled.disabled {
        tracing::warn!("rule {} disabled: {}", d.id, d.reason);
    }
    tracing::info!("ruleset {} ({source}): {} rules active, {} disabled, {} skipped", compiled.id, compiled.rules.len(), compiled.disabled.len(), compiled.skipped.len());

    let mut map = SessionMap::new();
    for (t, v) in &vault.data.map {
        map.insert_pair(t, v);
    }
    if !map.is_empty() {
        tracing::info!("{} placeholder mapping(s) restored from the vault", map.len());
    }
    let ogr = vault.data.ogr.clone();
    let mut rnd = [0u8; 6];
    rand::RngCore::fill_bytes(&mut rand::thread_rng(), &mut rnd);

    let client = reqwest::Client::builder().http2_adaptive_window(true).build()?;
    let state = Arc::new(AppState {
        args: args.clone(),
        compiled: RwLock::new(Arc::new(compiled)),
        ruleset_source: RwLock::new(source),
        engine: Mutex::new(Engine { map, cache: MaskCache::new(64 << 20) }),
        vault: Mutex::new(vault),
        client,
        activity: Mutex::new(activity::Log::new(500)),
        counters: activity::Counters::default(),
        started: Instant::now(),
        instance_id: format!("inst-{}", hex::encode(rnd)),
        ogr_ok: AtomicBool::new(false),
        ogr: if args.rules.is_none() { ogr.clone() } else { None },
        paused: AtomicBool::new(false),
    });
    if state.ogr.is_some() {
        tracing::info!("OpenGuardrails: reporting each step to {} ({})", state.ogr.as_ref().unwrap().runtime_url, if args.ogr_enforce { "ENFORCING block verdicts" } else { "observe only" });
    }

    if args.rules.is_none() {
        if let Some(o) = ogr {
            ogr::load_on_start(&state, &o.runtime_url, &o.api_key).await;
            tokio::spawn(ogr::heartbeat_loop(state.clone(), o.runtime_url, o.api_key, Duration::from_secs(30)));
        }
    }

    Ok(state)
}

/// Run the proxy until the listener fails or the task is dropped.
pub async fn serve_state(state: Arc<AppState>) -> Result<()> {
    let args = state.args.clone();
    let app = proxy::router(state);
    let listener = tokio::net::TcpListener::bind(args.listen).await?;
    tracing::info!(
        "openafw listening on http://{}  (status page: http://{}/__afw/); pass-through upstream: {}",
        args.listen,
        args.listen,
        args.upstream.clone().unwrap_or_else(|| "official endpoint per protocol".into())
    );
    axum::serve(listener, app).await?;
    Ok(())
}

pub async fn serve(args: ServeArgs) -> Result<()> {
    let state = build_state(args).await?;
    serve_state(state).await
}
