//! Agent takeover (design §4.1): point each agent's own config at OpenAFW,
//! keeping a backup in the vault so `unprotect` puts it back exactly.

use std::path::PathBuf;

use anyhow::{bail, Context, Result};

use crate::vault::Vault;

pub const KNOWN: &[&str] = &["claude", "codex", "gemini", "opencode", "openclaw", "hermes", "grokbuild"];

/// The display name and one-line description shown in the local UI.
pub fn describe(agent: &str) -> (&'static str, &'static str) {
    match agent {
        "claude" => ("Claude Code", "Anthropic Messages"),
        "codex" => ("Codex", "OpenAI Responses"),
        "gemini" => ("Gemini CLI", "API-key mode only"),
        "opencode" => ("OpenCode", "any provider"),
        "openclaw" => ("OpenClaw", "any provider"),
        "hermes" => ("Hermes", "any provider"),
        "grokbuild" => ("Grok Build", "manual setup"),
        _ => ("", ""),
    }
}

/// Can `protect` rewrite this agent's config by itself?
pub fn automatable(agent: &str) -> bool {
    matches!(agent, "claude" | "codex" | "gemini" | "opencode" | "openclaw" | "hermes")
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Protection {
    /// The config points at this OpenAFW.
    Protected,
    /// The config exists and points somewhere else.
    Unprotected,
    /// No config file yet — the agent has not been set up on this machine.
    NoConfig,
}

/// Does this agent's config currently route through `listen` (e.g. `127.0.0.1:4141`)?
/// A textual check: every adapter writes the address verbatim into its config.
pub fn protection(agent: &str, listen: &str) -> Protection {
    let Some(path) = config_path(agent) else { return Protection::NoConfig };
    match std::fs::read_to_string(&path) {
        Ok(text) if text.contains(listen) => Protection::Protected,
        Ok(_) => Protection::Unprotected,
        Err(_) => Protection::NoConfig,
    }
}

fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("."))
}

pub fn config_path(agent: &str) -> Option<PathBuf> {
    match agent {
        "claude" => Some(home().join(".claude").join("settings.json")),
        "codex" => Some(home().join(".codex").join("config.toml")),
        "gemini" => Some(home().join(".gemini").join(".env")),
        "opencode" => Some(
            std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| home().join(".config")).join("opencode").join("opencode.json"),
        ),
        "openclaw" => Some(home().join(".openclaw").join("openclaw.json")),
        "hermes" => Some(home().join(".hermes").join("config.yaml")),
        _ => None,
    }
}

/// The provider block an OpenCode / OpenClaw / Hermes takeover edits, per protocol family.
fn provider_of(profile_provider: Option<crate::vault::Provider>) -> crate::vault::Provider {
    profile_provider.unwrap_or(crate::vault::Provider::Anthropic)
}

fn backup(vault: &mut Vault, agent: &str, path: &PathBuf) -> Result<()> {
    if vault.data.backups.contains_key(agent) {
        return Ok(());
    }
    let text = std::fs::read_to_string(path).unwrap_or_default();
    vault.data.backups.insert(agent.to_string(), text);
    Ok(())
}

fn write(path: &PathBuf, text: &str) -> Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    std::fs::write(path, text).with_context(|| format!("writing {}", path.display()))
}

/// Rewrite the agent's config to route through `listen` (e.g. `http://127.0.0.1:4141`).
/// `token` is the agent's local credential when it routes via a vault profile;
/// None keeps the agent's own credentials (pass-through).
pub fn protect(vault: &mut Vault, agent: &str, listen: &str, token: Option<&str>, profile_provider: Option<crate::vault::Provider>) -> Result<String> {
    let base = listen.trim_end_matches('/');
    match agent {
        "claude" => {
            let path = config_path(agent).unwrap();
            backup(vault, agent, &path)?;
            let mut doc: serde_json::Value = match std::fs::read_to_string(&path) {
                Ok(t) if !t.trim().is_empty() => serde_json::from_str(&t).context("~/.claude/settings.json is not valid JSON")?,
                _ => serde_json::json!({}),
            };
            if !doc.is_object() {
                bail!("~/.claude/settings.json is not a JSON object");
            }
            let env = doc.as_object_mut().unwrap().entry("env").or_insert_with(|| serde_json::json!({}));
            if !env.is_object() {
                *env = serde_json::json!({});
            }
            let env = env.as_object_mut().unwrap();
            env.insert("ANTHROPIC_BASE_URL".into(), serde_json::Value::String(base.to_string()));
            if let Some(t) = token {
                env.insert("ANTHROPIC_AUTH_TOKEN".into(), serde_json::Value::String(t.to_string()));
                env.remove("ANTHROPIC_API_KEY");
            }
            write(&path, &format!("{}\n", serde_json::to_string_pretty(&doc)?))?;
            Ok(format!(
                "Claude Code → {base} (env.ANTHROPIC_BASE_URL in {}){}\nRestart Claude Code to pick it up.",
                path.display(),
                if token.is_some() { "; ANTHROPIC_AUTH_TOKEN set to the local token" } else { "; your own login/credentials pass through" }
            ))
        }
        "codex" => {
            let path = config_path(agent).unwrap();
            backup(vault, agent, &path)?;
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let mut doc: toml_edit::DocumentMut = text.parse().context("~/.codex/config.toml does not parse")?;
            doc["model_provider"] = toml_edit::value("openafw");
            let mut table = toml_edit::Table::new();
            table["name"] = toml_edit::value("OpenAFW");
            table["base_url"] = toml_edit::value(format!("{base}/v1"));
            table["wire_api"] = toml_edit::value("responses");
            if token.is_some() {
                table["env_key"] = toml_edit::value("AFW_CODEX_TOKEN");
            } else {
                table["requires_openai_auth"] = toml_edit::value(true);
            }
            if doc.get("model_providers").is_none() {
                doc["model_providers"] = toml_edit::Item::Table(toml_edit::Table::new());
            }
            doc["model_providers"]["openafw"] = toml_edit::Item::Table(table);
            write(&path, &doc.to_string())?;
            let mut msg = format!("Codex → {base}/v1 (model_provider = \"openafw\" in {})", path.display());
            if let Some(t) = token {
                msg.push_str(&format!("\nAdd to your shell profile:  export AFW_CODEX_TOKEN={t}"));
            } else {
                msg.push_str("\nYour ChatGPT login passes through; requests go to the profile's upstream.");
            }
            Ok(msg)
        }
        "gemini" => {
            let path = config_path(agent).unwrap();
            backup(vault, agent, &path)?;
            let text = std::fs::read_to_string(&path).unwrap_or_default();
            let mut lines: Vec<String> = text
                .lines()
                .filter(|l| !l.starts_with("GOOGLE_GEMINI_BASE_URL=") && !(token.is_some() && l.starts_with("GEMINI_API_KEY=")))
                .map(str::to_string)
                .collect();
            lines.push(format!("GOOGLE_GEMINI_BASE_URL={base}"));
            if let Some(t) = token {
                lines.push(format!("GEMINI_API_KEY={t}"));
            }
            write(&path, &format!("{}\n", lines.join("\n")))?;
            Ok(format!("Gemini CLI → {base} (GOOGLE_GEMINI_BASE_URL in {})\nNote: this applies to API-key mode only. A Google-account (OAuth) login talks to Google's Code Assist endpoint and ignores the base URL; set GEMINI_API_KEY (or use --profile) to route through OpenAFW.", path.display()))
        }
        "opencode" => {
            // ~/.config/opencode/opencode.json: provider.<id>.options.{baseURL, apiKey}.
            // OpenCode merges a partial block with its built-in provider definition, so
            // a block holding only `options` is valid. Which id: the profile's provider
            // (anthropic | openai); pass-through edits the anthropic block.
            let path = config_path(agent).unwrap();
            backup(vault, agent, &path)?;
            let mut doc: serde_json::Value = match std::fs::read_to_string(&path) {
                Ok(t) if !t.trim().is_empty() => serde_json::from_str(&t).context("opencode.json is not valid JSON")?,
                _ => serde_json::json!({ "$schema": "https://opencode.ai/config.json" }),
            };
            let prov = provider_of(profile_provider);
            let (id, url) = match prov {
                crate::vault::Provider::Anthropic => ("anthropic", format!("{base}/v1")),
                crate::vault::Provider::Gemini => ("google", base.to_string()),
                _ => ("openai", format!("{base}/v1")),
            };
            let providers = doc.as_object_mut().unwrap().entry("provider").or_insert_with(|| serde_json::json!({}));
            if !providers.is_object() {
                *providers = serde_json::json!({});
            }
            let block = providers.as_object_mut().unwrap().entry(id).or_insert_with(|| serde_json::json!({}));
            let options = block.as_object_mut().unwrap().entry("options").or_insert_with(|| serde_json::json!({}));
            let options = options.as_object_mut().unwrap();
            options.insert("baseURL".into(), serde_json::Value::String(url.clone()));
            if let Some(t) = token {
                options.insert("apiKey".into(), serde_json::Value::String(t.to_string()));
            }
            write(&path, &format!("{}\n", serde_json::to_string_pretty(&doc)?))?;
            Ok(format!("OpenCode provider `{id}` → {url} (options.baseURL in {}){}", path.display(),
                if token.is_some() { "; options.apiKey set to the local token" } else { "; its own key passes through" }))
        }
        "openclaw" => {
            // ~/.openclaw/openclaw.json (JSON5): models.providers.<id>.{baseUrl, apiKey, api}.
            // Comments in the file are not preserved (a JSON5 parse, a JSON write); the
            // original is kept in the vault and restored byte for byte by `unprotect`.
            let path = config_path(agent).unwrap();
            backup(vault, agent, &path)?;
            let text = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
            let mut doc: serde_json::Value = json5::from_str(&text).context("openclaw.json does not parse as JSON5")?;
            let prov = provider_of(profile_provider);
            let (id, url, api) = match prov {
                crate::vault::Provider::Anthropic => ("anthropic", base.to_string(), "anthropic-messages"),
                crate::vault::Provider::Gemini => ("google", base.to_string(), "google-generative-ai"),
                _ => ("openai", format!("{base}/v1"), "openai-completions"),
            };
            let models = doc.as_object_mut().context("openclaw.json root is not an object")?.entry("models").or_insert_with(|| serde_json::json!({}));
            let providers = models.as_object_mut().context("models is not an object")?.entry("providers").or_insert_with(|| serde_json::json!({}));
            let block = providers.as_object_mut().context("models.providers is not an object")?.entry(id).or_insert_with(|| serde_json::json!({ "api": api }));
            let b = block.as_object_mut().unwrap();
            b.insert("baseUrl".into(), serde_json::Value::String(url.clone()));
            if let Some(t) = token {
                b.insert("apiKey".into(), serde_json::Value::String(t.to_string()));
            }
            write(&path, &format!("{}\n", serde_json::to_string_pretty(&doc)?))?;
            Ok(format!("OpenClaw provider `{id}` → {url} (models.providers.{id}.baseUrl in {}); comments in the file were not preserved, the original is in the vault", path.display()))
        }
        "hermes" => {
            // ~/.hermes/config.yaml: model.{provider, base_url} and custom_providers[].{name, base_url, api_key}.
            let path = config_path(agent).unwrap();
            backup(vault, agent, &path)?;
            let text = std::fs::read_to_string(&path).unwrap_or_else(|_| "{}".into());
            let mut doc: serde_yaml::Value = serde_yaml::from_str(&text).context("config.yaml does not parse")?;
            if doc.is_null() {
                doc = serde_yaml::Value::Mapping(Default::default());
            }
            let prov = provider_of(profile_provider);
            let url = match prov {
                crate::vault::Provider::Anthropic => base.to_string(),
                _ => format!("{base}/v1"),
            };
            let root = doc.as_mapping_mut().context("config.yaml root is not a mapping")?;
            let model = root.entry("model".into()).or_insert_with(|| serde_yaml::Value::Mapping(Default::default()));
            let m = model.as_mapping_mut().context("model is not a mapping")?;
            m.insert("base_url".into(), serde_yaml::Value::String(url.clone()));
            if let Some(t) = token {
                m.insert("api_key".into(), serde_yaml::Value::String(t.to_string()));
            }
            write(&path, &serde_yaml::to_string(&doc)?)?;
            Ok(format!("Hermes model.base_url → {url} in {}; comments in the file were not preserved, the original is in the vault", path.display()))
        }
        "grokbuild" => {
            let cred = token.map(|t| format!("\nUse this as the API key: {t}")).unwrap_or_default();
            Ok(format!("No automatic takeover for grokbuild yet. Set base_url = \"{base}/v1\" in its config.toml.{cred}"))
        }
        other => bail!("unknown agent {other:?}; known: {}", KNOWN.join(", ")),
    }
}

pub fn unprotect(vault: &mut Vault, agent: &str) -> Result<String> {
    let Some(path) = config_path(agent) else { bail!("nothing to restore for {agent}") };
    match vault.data.backups.remove(agent) {
        Some(text) if text.is_empty() => {
            let _ = std::fs::remove_file(&path);
            Ok(format!("{} removed (it did not exist before protect)", path.display()))
        }
        Some(text) => {
            write(&path, &text)?;
            Ok(format!("{} restored from the backup taken at protect time", path.display()))
        }
        None => bail!("no backup for {agent}; edit {} by hand", path.display()),
    }
}
