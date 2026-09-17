//! OpenAFW — a local AI firewall for coding agents (docs/architecture.md).

use afw_engine::{compile, DEFAULT_TIERS};
use anyhow::{bail, Context, Result};
use clap::{Parser, Subcommand};
use openafw::{agents, ogr, open_vault, service, vault, Profile, Provider, ServeArgs, Vault};
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "openafw", version, about = "Local AI firewall: secrets never leave this machine")]
struct Cli {
    #[command(subcommand)]
    command: Option<Command>,
    #[command(flatten)]
    serve: ServeArgs,
}


#[derive(Subcommand, Debug)]
enum Command {
    /// Run the firewall (the default when no command is given).
    Serve,
    /// Show what is configured.
    Status,
    /// Manage upstream profiles (provider + base URL + key).
    Profile {
        #[command(subcommand)]
        cmd: ProfileCmd,
    },
    /// Route an agent through a profile (mints the agent's local token).
    Agent {
        #[command(subcommand)]
        cmd: AgentCmd,
    },
    /// Point an agent's own config at OpenAFW.
    Protect {
        /// claude | codex | gemini | opencode | openclaw | hermes | grokbuild
        agent: String,
        /// Route through this profile (sets the agent's credential to its local token).
        #[arg(long)]
        profile: Option<String>,
    },
    /// Restore an agent's config from the backup taken by `protect`.
    Unprotect { agent: String },
    /// Connect to OpenGuardrails (served rulesets, heartbeat).
    Connect {
        #[arg(long)]
        runtime: String,
        /// The organization key; `-` reads it from stdin.
        #[arg(long)]
        key: String,
    },
    /// Forget the OpenGuardrails connection.
    Disconnect,
    /// Forget every persisted placeholder mapping (the agents' histories will re-mask from rules).
    ForgetMap,
    /// Run OpenAFW at login as a background service (launchd / systemd --user / Task Scheduler).
    Service {
        #[command(subcommand)]
        cmd: ServiceCmd,
    },
}

#[derive(Subcommand, Debug)]
enum ServiceCmd {
    Install,
    Uninstall,
    Status,
}

#[derive(Subcommand, Debug)]
enum ProfileCmd {
    /// Add or replace a profile. The key is read from --key-stdin, --key-env, or --key.
    Add {
        name: String,
        #[arg(long, value_enum)]
        provider: Provider,
        #[arg(long)]
        base_url: Option<String>,
        /// Read the key from stdin (recommended: keeps it out of shell history).
        #[arg(long, default_value_t = false)]
        key_stdin: bool,
        /// Read the key from this environment variable.
        #[arg(long)]
        key_env: Option<String>,
        /// The key itself (lands in shell history; prefer the other two).
        #[arg(long)]
        key: Option<String>,
        /// No key: the agent's own credentials pass through to this base URL.
        #[arg(long, default_value_t = false)]
        passthrough: bool,
    },
    List,
    Remove { name: String },
}

#[derive(Subcommand, Debug)]
enum AgentCmd {
    /// Route `agent` through `profile`; prints the agent's local token.
    Set { agent: String, profile: String },
    List,
    Remove { agent: String },
}



fn read_key(key_stdin: bool, key_env: Option<String>, key: Option<String>) -> Result<String> {
    if key_stdin {
        let mut s = String::new();
        std::io::stdin().read_line(&mut s)?;
        let s = s.trim().to_string();
        if s.is_empty() {
            bail!("no key on stdin");
        }
        return Ok(s);
    }
    if let Some(var) = key_env {
        return std::env::var(&var).with_context(|| format!("environment variable {var} is not set"));
    }
    key.context("give the key with --key-stdin, --key-env VAR, or --key (or --passthrough)")
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();
    let cli = Cli::parse();
    match cli.command.unwrap_or(Command::Serve) {
        Command::Serve => openafw::serve(cli.serve).await,
        Command::Service { cmd } => {
            let msg = match cmd {
                ServiceCmd::Install => service::install(cli.serve.listen)?,
                ServiceCmd::Uninstall => service::uninstall()?,
                ServiceCmd::Status => service::status()?,
            };
            println!("{msg}");
            Ok(())
        }
        Command::Status => {
            let v = open_vault()?;
            println!("vault:    {}", Vault::path().display());
            println!("listen:   http://{}", cli.serve.listen);
            println!("profiles: {}", v.data.profiles.len());
            for p in &v.data.profiles {
                println!("  {:<16} {:<18} {} {}", p.name, format!("{:?}", p.provider).to_lowercase(), p.base_url, if p.api_key.is_some() { "(key)" } else { "(passthrough)" });
            }
            println!("agents:   {}", v.data.agents.len());
            for a in &v.data.agents {
                println!("  {:<10} → {}", a.agent, a.profile);
            }
            println!("map:      {} placeholder(s) persisted", v.data.map.len());
            match &v.data.ogr {
                Some(o) => println!("ogr:      {}", o.runtime_url),
                None => println!("ogr:      not connected"),
            }
            Ok(())
        }
        Command::Profile { cmd } => {
            let mut v = open_vault()?;
            match cmd {
                ProfileCmd::Add { name, provider, base_url, key_stdin, key_env, key, passthrough } => {
                    let api_key = if passthrough { None } else { Some(read_key(key_stdin, key_env, key)?) };
                    let base_url = base_url.unwrap_or_else(|| provider.default_base_url().to_string());
                    if base_url.is_empty() {
                        bail!("--base-url is required for this provider");
                    }
                    v.data.profiles.retain(|p| p.name != name);
                    v.data.profiles.push(Profile { name: name.clone(), provider, base_url: base_url.clone(), api_key });
                    v.save()?;
                    println!("profile {name} → {base_url}");
                }
                ProfileCmd::List => {
                    for p in &v.data.profiles {
                        println!("{:<16} {:<18} {} {}", p.name, format!("{:?}", p.provider).to_lowercase(), p.base_url, if p.api_key.is_some() { "(key)" } else { "(passthrough)" });
                    }
                }
                ProfileCmd::Remove { name } => {
                    let before = v.data.profiles.len();
                    v.data.profiles.retain(|p| p.name != name);
                    if v.data.profiles.len() == before {
                        bail!("no profile {name}");
                    }
                    v.data.agents.retain(|a| a.profile != name);
                    v.save()?;
                    println!("removed {name}");
                }
            }
            Ok(())
        }
        Command::Agent { cmd } => {
            let mut v = open_vault()?;
            match cmd {
                AgentCmd::Set { agent, profile } => {
                    let token = v.set_agent(&agent, &profile)?;
                    v.save()?;
                    println!("{agent} → {profile}\nlocal token for {agent}: {token}\nRun `openafw protect {agent} --profile {profile}` to write it into the agent's config.");
                }
                AgentCmd::List => {
                    for a in &v.data.agents {
                        println!("{:<10} → {:<16} token {}…", a.agent, a.profile, &a.token[..a.token.len().min(14)]);
                    }
                }
                AgentCmd::Remove { agent } => {
                    v.data.agents.retain(|a| a.agent != agent);
                    v.save()?;
                    println!("removed {agent}");
                }
            }
            Ok(())
        }
        Command::Protect { agent, profile } => {
            let mut v = open_vault()?;
            let token = match &profile {
                Some(p) => Some(v.set_agent(&agent, p)?),
                None => v.route_for_agent(&agent).map(|r| r.token.clone()),
            };
            let prov = v.route_for_agent(&agent).map(|r| r.profile.clone()).and_then(|name| v.profile(&name).map(|p| p.provider));
            let msg = agents::protect(&mut v, &agent, &format!("http://{}", cli.serve.listen), token.as_deref(), prov)?;
            v.save()?;
            println!("{msg}");
            Ok(())
        }
        Command::Unprotect { agent } => {
            let mut v = open_vault()?;
            let msg = agents::unprotect(&mut v, &agent)?;
            v.save()?;
            println!("{msg}");
            Ok(())
        }
        Command::Connect { runtime, key } => {
            let key = if key == "-" {
                let mut s = String::new();
                std::io::stdin().read_line(&mut s)?;
                s.trim().to_string()
            } else {
                key
            };
            let client = reqwest::Client::new();
            let rs = ogr::probe(&client, &runtime, &key).await?;
            let compiled = compile(&rs, DEFAULT_TIERS);
            let mut v = open_vault()?;
            v.data.ogr = Some(vault::OgrConnection { runtime_url: runtime.clone(), api_key: key });
            v.save()?;
            println!("connected to {runtime}: ruleset {} ({} rules, {} disabled here)", rs.id, compiled.rules.len(), compiled.disabled.len());
            for d in &compiled.disabled {
                println!("  disabled {}: {}", d.id, d.reason);
            }
            Ok(())
        }
        Command::Disconnect => {
            let mut v = open_vault()?;
            v.data.ogr = None;
            v.save()?;
            println!("disconnected");
            Ok(())
        }
        Command::ForgetMap => {
            let mut v = open_vault()?;
            let n = v.data.map.len();
            v.data.map.clear();
            v.save()?;
            println!("forgot {n} placeholder mapping(s)");
            Ok(())
        }
    }
}
