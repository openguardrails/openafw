//! Run OpenAFW at login. macOS: a launchd user agent; Linux: a systemd user
//! unit; Windows: a Task Scheduler task. Each uses the OS's own mechanism,
//! nothing bundled, and each is reversible with `uninstall`.

use std::net::SocketAddr;
use std::path::PathBuf;
use std::process::Command;

use anyhow::{bail, Context, Result};

use crate::vault::home_dir;

const LABEL: &str = "com.openguardrails.openafw";

fn exe() -> Result<PathBuf> {
    std::env::current_exe().context("cannot locate the openafw executable")
}

fn run(cmd: &mut Command) -> Result<(bool, String)> {
    let out = cmd.output().with_context(|| format!("running {:?}", cmd.get_program()))?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    Ok((out.status.success(), text))
}

#[cfg(target_os = "macos")]
mod imp {
    use super::*;

    fn plist_path() -> PathBuf {
        dirs::home_dir().unwrap_or_default().join("Library").join("LaunchAgents").join(format!("{LABEL}.plist"))
    }
    fn domain() -> String {
        let uid = unsafe { libc_getuid() };
        format!("gui/{uid}")
    }
    extern "C" {
        #[link_name = "getuid"]
        fn libc_getuid() -> u32;
    }

    pub fn install(listen: SocketAddr) -> Result<String> {
        let exe = exe()?;
        let log = home_dir().join("openafw.log");
        std::fs::create_dir_all(home_dir())?;
        let plist = format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>{LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>{}</string><string>serve</string><string>--listen</string><string>{listen}</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>{env}
  <key>StandardOutPath</key><string>{}</string>
  <key>StandardErrorPath</key><string>{}</string>
</dict>
</plist>
"#,
            exe.display(),
            log.display(),
            log.display(),
            env = "{env}"
        );
        let path = plist_path();
        std::fs::create_dir_all(path.parent().unwrap())?;
        let env = match std::env::var("AFW_HOME") {
            Ok(h) => format!("\n  <key>EnvironmentVariables</key><dict><key>AFW_HOME</key><string>{h}</string></dict>"),
            Err(_) => String::new(),
        };
        let plist = plist.replace("{env}", &env);
        let _ = run(Command::new("launchctl").args(["bootout", &format!("{}/{LABEL}", domain())]));
        std::fs::write(&path, plist)?;
        let (ok, text) = run(Command::new("launchctl").args(["bootstrap", &domain(), path.to_str().unwrap()]))?;
        if !ok {
            bail!("launchctl bootstrap failed: {}", text.trim());
        }
        Ok(format!("installed {} and started it (log: {})", path.display(), log.display()))
    }

    pub fn uninstall() -> Result<String> {
        let path = plist_path();
        let _ = run(Command::new("launchctl").args(["bootout", &format!("{}/{LABEL}", domain())]));
        if path.exists() {
            std::fs::remove_file(&path)?;
            Ok(format!("stopped and removed {}", path.display()))
        } else {
            Ok("no service was installed".into())
        }
    }

    pub fn status() -> Result<String> {
        let (ok, text) = run(Command::new("launchctl").args(["print", &format!("{}/{LABEL}", domain())]))?;
        if !ok {
            return Ok(format!("not installed ({})", plist_path().display()));
        }
        let state = text.lines().find(|l| l.trim().starts_with("state =")).map(|l| l.trim().to_string()).unwrap_or_else(|| "state = ?".into());
        let pid = text.lines().find(|l| l.trim().starts_with("pid =")).map(|l| l.trim().to_string()).unwrap_or_default();
        Ok(format!("installed: {} ({} {})", plist_path().display(), state, pid))
    }
}

#[cfg(target_os = "linux")]
mod imp {
    use super::*;

    fn unit_path() -> PathBuf {
        let base = std::env::var("XDG_CONFIG_HOME").map(PathBuf::from).unwrap_or_else(|_| dirs::home_dir().unwrap_or_default().join(".config"));
        base.join("systemd").join("user").join("openafw.service")
    }

    pub fn install(listen: SocketAddr) -> Result<String> {
        let exe = exe()?;
        let unit = format!(
            "[Unit]\nDescription=OpenAFW local AI firewall\nAfter=network.target\n\n[Service]\nExecStart={} serve --listen {listen}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n",
            exe.display()
        );
        let path = unit_path();
        std::fs::create_dir_all(path.parent().unwrap())?;
        std::fs::write(&path, unit)?;
        run(Command::new("systemctl").args(["--user", "daemon-reload"]))?;
        let (ok, text) = run(Command::new("systemctl").args(["--user", "enable", "--now", "openafw.service"]))?;
        if !ok {
            bail!("systemctl --user enable --now failed: {}", text.trim());
        }
        Ok(format!("installed {} and started it (journalctl --user -u openafw)", path.display()))
    }

    pub fn uninstall() -> Result<String> {
        let path = unit_path();
        let _ = run(Command::new("systemctl").args(["--user", "disable", "--now", "openafw.service"]));
        if path.exists() {
            std::fs::remove_file(&path)?;
            let _ = run(Command::new("systemctl").args(["--user", "daemon-reload"]));
            Ok(format!("stopped and removed {}", path.display()))
        } else {
            Ok("no service was installed".into())
        }
    }

    pub fn status() -> Result<String> {
        if !unit_path().exists() {
            return Ok(format!("not installed ({})", unit_path().display()));
        }
        let (_, text) = run(Command::new("systemctl").args(["--user", "is-active", "openafw.service"]))?;
        Ok(format!("installed: {} ({})", unit_path().display(), text.trim()))
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use super::*;
    const TASK: &str = "OpenAFW";

    pub fn install(listen: SocketAddr) -> Result<String> {
        let exe = exe()?;
        let tr = format!("\"{}\" serve --listen {listen}", exe.display());
        let (ok, text) = run(Command::new("schtasks").args(["/Create", "/F", "/SC", "ONLOGON", "/RL", "LIMITED", "/TN", TASK, "/TR", &tr]))?;
        if !ok {
            bail!("schtasks /Create failed: {}", text.trim());
        }
        let _ = run(Command::new("schtasks").args(["/Run", "/TN", TASK]));
        Ok(format!("installed scheduled task {TASK} (runs at logon) and started it"))
    }

    pub fn uninstall() -> Result<String> {
        let _ = run(Command::new("schtasks").args(["/End", "/TN", TASK]));
        let (ok, text) = run(Command::new("schtasks").args(["/Delete", "/F", "/TN", TASK]))?;
        if ok {
            Ok(format!("removed scheduled task {TASK}"))
        } else if text.contains("cannot find") || text.to_lowercase().contains("does not exist") {
            Ok("no service was installed".into())
        } else {
            bail!("schtasks /Delete failed: {}", text.trim())
        }
    }

    pub fn status() -> Result<String> {
        let (ok, text) = run(Command::new("schtasks").args(["/Query", "/TN", TASK, "/FO", "LIST"]))?;
        if !ok {
            return Ok("not installed".into());
        }
        let status = text.lines().find(|l| l.trim_start().starts_with("Status:")).map(|l| l.trim().to_string()).unwrap_or_default();
        Ok(format!("installed: scheduled task {TASK} ({status})"))
    }
}

#[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
mod imp {
    use super::*;
    pub fn install(_: SocketAddr) -> Result<String> {
        bail!("no service integration for this platform")
    }
    pub fn uninstall() -> Result<String> {
        bail!("no service integration for this platform")
    }
    pub fn status() -> Result<String> {
        Ok("no service integration for this platform".into())
    }
}

pub fn install(listen: SocketAddr) -> Result<String> {
    imp::install(listen)
}
pub fn uninstall() -> Result<String> {
    imp::uninstall()
}
pub fn status() -> Result<String> {
    imp::status()
}
