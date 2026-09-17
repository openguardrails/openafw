//! The local key vault (design §7): provider profiles, per-agent routes, the
//! persisted value ↔ token map and the OGR connection — one JSON document,
//! AES-256-GCM at rest. The master key is a 32-byte random key in
//! `~/.openafw/master.key` (mode 0600, created on first use), or
//! `AFW_MASTER_KEY` when set. No OS keychain: the same code path on macOS,
//! Windows and Linux, nothing that can be unavailable in a headless session.
//! What the encryption buys is that a copied or backed-up vault file is
//! useless without the key file beside it.
//!
//! The vault file never holds plaintext. Logs never hold values.

use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use anyhow::{anyhow, bail, Context, Result};
use rand::RngCore;
use serde::{Deserialize, Serialize};

const MAGIC: &[u8; 4] = b"AFW1";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, clap::ValueEnum)]
#[serde(rename_all = "snake_case")]
pub enum Provider {
    Anthropic,
    Openai,
    Gemini,
    /// Any OpenAI-compatible endpoint (relays, local servers).
    OpenaiCompatible,
}

impl Provider {
    pub fn default_base_url(self) -> &'static str {
        match self {
            Provider::Anthropic => "https://api.anthropic.com",
            Provider::Openai => "https://api.openai.com",
            Provider::Gemini => "https://generativelanguage.googleapis.com",
            Provider::OpenaiCompatible => "",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Profile {
    pub name: String,
    pub provider: Provider,
    pub base_url: String,
    /// The upstream credential. None = pass the agent's own through.
    pub api_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRoute {
    /// claude | codex | gemini | opencode | openclaw | hermes | grokbuild | custom names
    pub agent: String,
    /// The local credential the agent holds: `afw_<agent>_<random>`.
    pub token: String,
    pub profile: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OgrConnection {
    pub runtime_url: String,
    pub api_key: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct VaultData {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub profiles: Vec<Profile>,
    #[serde(default)]
    pub agents: Vec<AgentRoute>,
    /// (token, value) pairs — the persisted session map.
    #[serde(default)]
    pub map: Vec<(String, String)>,
    #[serde(default)]
    pub ogr: Option<OgrConnection>,
    /// Backups of agent config files taken by `protect`, keyed by agent.
    #[serde(default)]
    pub backups: std::collections::BTreeMap<String, String>,
}

pub struct Vault {
    pub data: VaultData,
    path: PathBuf,
    key: [u8; 32],
}

pub fn home_dir() -> PathBuf {
    if let Ok(p) = std::env::var("AFW_HOME") {
        return PathBuf::from(p);
    }
    dirs::home_dir().map(|h| h.join(".openafw")).unwrap_or_else(|| PathBuf::from(".openafw"))
}

fn ensure_dir(dir: &Path) -> Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

fn write_private(path: &Path, bytes: &[u8]) -> Result<()> {
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
        let mut f = opts.open(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn parse_key(raw: &str) -> Option<[u8; 32]> {
    let raw = raw.trim();
    let bytes = if raw.len() == 64 { hex::decode(raw).ok()? } else { return None };
    bytes.try_into().ok()
}

/// Master keys in preference order: `AFW_MASTER_KEY`, then the key file.
fn candidate_keys(dir: &Path, log: &mut Vec<String>) -> Vec<(String, [u8; 32])> {
    let mut out = Vec::new();
    if let Ok(raw) = std::env::var("AFW_MASTER_KEY") {
        match parse_key(&raw) {
            Some(k) => out.push(("env".to_string(), k)),
            None => log.push("AFW_MASTER_KEY is set but is not 64 hex characters; ignoring it".into()),
        }
    }
    let key_file = dir.join("master.key");
    if let Ok(raw) = std::fs::read_to_string(&key_file) {
        match parse_key(&raw) {
            Some(k) => out.push(("file".to_string(), k)),
            None => log.push(format!("{} is not a 64-hex key; ignoring it", key_file.display())),
        }
    }
    out
}

fn create_key(dir: &Path, log: &mut Vec<String>) -> Result<[u8; 32]> {
    let mut key = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut key);
    ensure_dir(dir)?;
    let key_file = dir.join("master.key");
    write_private(&key_file, hex::encode(key).as_bytes())?;
    log.push(format!("new master key created at {} (0600)", key_file.display()));
    Ok(key)
}

impl Vault {
    pub fn path() -> PathBuf {
        home_dir().join("vault.bin")
    }

    /// Open (or create) the vault. `notes` receives human-readable events
    /// about key storage for the caller to log.
    pub fn open(notes: &mut Vec<String>) -> Result<Vault> {
        let dir = home_dir();
        ensure_dir(&dir)?;
        let path = Self::path();
        let candidates = candidate_keys(&dir, notes);
        if path.exists() {
            let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
            for (source, key) in &candidates {
                if let Ok(data) = decrypt(key, &bytes) {
                    if source != "env" && candidates.first().map(|c| &c.0) != Some(source) {
                        notes.push(format!("vault opened with the {source} master key"));
                    }
                    return Ok(Vault { data, path, key: *key });
                }
            }
            bail!(
                "{} does not decrypt with any available master key ({}); restore master.key beside it, set AFW_MASTER_KEY, or move the vault aside to start fresh",
                path.display(),
                if candidates.is_empty() { "none found".to_string() } else { candidates.iter().map(|c| c.0.as_str()).collect::<Vec<_>>().join(", ") }
            );
        }
        let key = match candidates.first() {
            Some((_, k)) => *k,
            None => create_key(&dir, notes)?,
        };
        Ok(Vault { data: VaultData { version: 1, ..Default::default() }, path, key })
    }

    pub fn save(&self) -> Result<()> {
        let bytes = encrypt(&self.key, &self.data)?;
        write_private(&self.path, &bytes)
    }

    pub fn profile(&self, name: &str) -> Option<&Profile> {
        self.data.profiles.iter().find(|p| p.name == name)
    }

    pub fn route_for_token(&self, token: &str) -> Option<(&AgentRoute, &Profile)> {
        let route = self.data.agents.iter().find(|a| a.token == token)?;
        let profile = self.profile(&route.profile)?;
        Some((route, profile))
    }

    pub fn route_for_agent(&self, agent: &str) -> Option<&AgentRoute> {
        self.data.agents.iter().find(|a| a.agent == agent)
    }

    /// Point an agent at a profile, minting its local token if it has none.
    pub fn set_agent(&mut self, agent: &str, profile: &str) -> Result<String> {
        if self.profile(profile).is_none() {
            bail!("no profile named {profile:?}");
        }
        if let Some(r) = self.data.agents.iter_mut().find(|a| a.agent == agent) {
            r.profile = profile.to_string();
            return Ok(r.token.clone());
        }
        let mut rnd = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut rnd);
        let token = format!("afw_{}_{}", agent, hex::encode(rnd));
        self.data.agents.push(AgentRoute { agent: agent.to_string(), token: token.clone(), profile: profile.to_string() });
        Ok(token)
    }
}

fn encrypt(key: &[u8; 32], data: &VaultData) -> Result<Vec<u8>> {
    let cipher = Aes256Gcm::new(key.into());
    let mut nonce = [0u8; 12];
    rand::thread_rng().fill_bytes(&mut nonce);
    let plain = serde_json::to_vec(data)?;
    let ct = cipher.encrypt(Nonce::from_slice(&nonce), plain.as_ref()).map_err(|_| anyhow!("encrypt failed"))?;
    let mut out = Vec::with_capacity(4 + 12 + ct.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&ct);
    Ok(out)
}

fn decrypt(key: &[u8; 32], bytes: &[u8]) -> Result<VaultData> {
    if bytes.len() < 16 || &bytes[..4] != MAGIC {
        bail!("not an OpenAFW vault file");
    }
    let cipher = Aes256Gcm::new(key.into());
    let nonce = Nonce::from_slice(&bytes[4..16]);
    let plain = cipher.decrypt(nonce, &bytes[16..]).map_err(|_| anyhow!("decrypt failed"))?;
    Ok(serde_json::from_slice(&plain)?)
}

/// Is this credential one of ours?
pub fn is_local_token(cred: &str) -> bool {
    cred.starts_with("afw_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn roundtrip() {
        let key = [7u8; 32];
        let mut data = VaultData { version: 1, ..Default::default() };
        data.map.push(("${OGR_SECRET_1}".into(), "hunter2".into()));
        let bytes = encrypt(&key, &data).unwrap();
        assert!(!bytes.windows(7).any(|w| w == b"hunter2"));
        let back = decrypt(&key, &bytes).unwrap();
        assert_eq!(back.map, data.map);
        assert!(decrypt(&[8u8; 32], &bytes).is_err());
    }
}
