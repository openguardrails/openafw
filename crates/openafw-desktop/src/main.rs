//! The desktop shell (design §10.5): the same daemon as `openafw serve`
//! running in-process, plus a menu-bar/tray icon and a window showing the
//! local status page. macOS and Windows are the primary targets; the Linux
//! build works (WebKitGTK + libappindicator) but the CLI + systemd user
//! service is the primary Linux path.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use clap::Parser;
use openafw::{service, AppState, ServeArgs};
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindowBuilder};
use tracing_subscriber::EnvFilter;

/// The in-process daemon's state, once it has started. `None` means the shell
/// attached to a daemon that was already listening (an installed service), and
/// every control goes over the loopback API instead.
type Slot = Arc<Mutex<Option<Arc<AppState>>>>;

/// The menu-bar icon: monochrome with alpha, so macOS treats it as a template
/// image and inverts it for light/dark automatically.
const TRAY_ICON: &[u8] = include_bytes!("../icons/tray@2x.png");

struct Shell {
    args: ServeArgs,
    slot: Slot,
    http: reqwest::blocking::Client,
}

impl Shell {
    fn status_url(&self) -> String {
        format!("http://{}/__afw/", self.args.listen)
    }

    fn api(&self, path: &str) -> String {
        format!("http://{}/__afw/api/{path}", self.args.listen)
    }

    fn healthy(&self) -> bool {
        self.http
            .get(format!("http://{}/__afw/health", self.args.listen))
            .timeout(Duration::from_millis(600))
            .send()
            .map(|r| r.status().is_success())
            .unwrap_or(false)
    }

    fn status(&self) -> Option<serde_json::Value> {
        self.http.get(self.api("status")).timeout(Duration::from_millis(800)).send().ok()?.json().ok()
    }

    fn paused(&self) -> bool {
        if let Some(st) = self.slot.lock().unwrap().as_ref() {
            return st.paused.load(Ordering::Relaxed);
        }
        self.status().and_then(|v| v.get("paused").and_then(|p| p.as_bool())).unwrap_or(false)
    }

    /// Flip the pause flag — directly when we own the daemon, over the API when we attached.
    fn set_paused(&self, paused: bool) {
        if let Some(st) = self.slot.lock().unwrap().as_ref() {
            st.paused.store(paused, Ordering::Relaxed);
            if paused {
                tracing::warn!("PAUSED: requests now pass through unmasked");
            } else {
                tracing::info!("resumed: masking on");
            }
            return;
        }
        let _ = self
            .http
            .post(self.api("pause"))
            .json(&serde_json::json!({ "paused": paused }))
            .timeout(Duration::from_millis(800))
            .send();
    }
}

fn open_window(app: &AppHandle, url: &str) {
    // An Accessory app is not activated by opening a window; ask for it.
    #[cfg(target_os = "macos")]
    {
        use tauri::ActivationPolicy;
        let _ = app.set_activation_policy(ActivationPolicy::Regular);
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        return;
    }
    let parsed = match url.parse() {
        Ok(u) => u,
        Err(e) => {
            tracing::error!("bad status url {url}: {e}");
            return;
        }
    };
    match WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("OpenAFW")
        .inner_size(1060.0, 780.0)
        .min_inner_size(640.0, 480.0)
        .center()
        .build()
    {
        Ok(w) => {
            tracing::info!("window opened on {url}");
            let handle = w.clone();
            w.on_window_event(move |ev| {
                // Closing hides: the daemon and the tray stay, and the next
                // "Open" is instant instead of reloading the page.
                if let tauri::WindowEvent::CloseRequested { api, .. } = ev {
                    api.prevent_close();
                    let _ = handle.hide();
                    // Back to a menu-bar-only app: the Dock icon goes with the window.
                    #[cfg(target_os = "macos")]
                    {
                        let _ = handle.app_handle().set_activation_policy(tauri::ActivationPolicy::Accessory);
                    }
                }
            });
            let _ = w.set_focus();
        }
        Err(e) => tracing::error!("window: {e}"),
    }
}

fn tray_tooltip(shell: &Shell) -> String {
    match shell.status() {
        Some(s) => {
            let c = &s["counters"];
            let paused = s["paused"].as_bool().unwrap_or(false);
            format!(
                "OpenAFW — {}\n{} requests, {} secrets masked, {} restored",
                if paused { "PAUSED (unmasked)" } else { "protecting" },
                c["requests"].as_u64().unwrap_or(0),
                c["minted"].as_u64().unwrap_or(0),
                c["restored"].as_u64().unwrap_or(0)
            )
        }
        None => "OpenAFW — starting…".to_string(),
    }
}

fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")))
        .with_target(false)
        .init();

    // The shell takes `openafw serve`'s defaults (and its env vars); the CLI is
    // where flags are passed, so argv here is not parsed as daemon flags.
    let args = ServeArgs::parse_from(std::env::args().take(1));
    let shell = Arc::new(Shell {
        args: args.clone(),
        slot: Arc::new(Mutex::new(None)),
        http: reqwest::blocking::Client::new(),
    });

    // A daemon may already be running (installed as a service): attach rather
    // than fight it for the port.
    if shell.healthy() {
        tracing::info!("a daemon already answers on {}; attaching", args.listen);
    } else {
        let slot = shell.slot.clone();
        let args = args.clone();
        std::thread::Builder::new()
            .name("openafw-daemon".into())
            .spawn(move || {
                let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
                rt.block_on(async move {
                    match openafw::build_state(args).await {
                        Ok(st) => {
                            *slot.lock().unwrap() = Some(st.clone());
                            if let Err(e) = openafw::serve_state(st).await {
                                tracing::error!("daemon stopped: {e:#}");
                            }
                        }
                        Err(e) => tracing::error!("daemon failed to start: {e:#}"),
                    }
                });
            })
            .expect("daemon thread");
    }

    let setup_shell = shell.clone();
    tauri::Builder::default()
        .setup(move |app| {
            // A menu-bar utility: no Dock icon, no app menu until a window is
            // opened. The tray is the entry point, and closing the window
            // leaves the firewall running.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let shell = setup_shell.clone();
            let paused_now = shell.paused();
            let at_login = service::status().map(|s| s.starts_with("installed")).unwrap_or(false);

            let open = MenuItem::with_id(app, "open", "Open OpenAFW", true, None::<&str>)?;
            let pause = CheckMenuItem::with_id(app, "pause", "Pause protection", true, paused_now, None::<&str>)?;
            let login = CheckMenuItem::with_id(app, "login", "Start at login", true, at_login, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit OpenAFW", true, None::<&str>)?;
            let sep = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(app, &[&open, &pause, &sep, &login, &sep, &quit])?;

            let menu_shell = shell.clone();
            let pause_item = pause.clone();
            let login_item = login.clone();

            let mut tray = TrayIconBuilder::with_id("main")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .tooltip("OpenAFW — local AI firewall");
            match Image::from_bytes(TRAY_ICON) {
                Ok(img) => tray = tray.icon(img).icon_as_template(true),
                Err(e) => {
                    tracing::warn!("tray icon: {e}; falling back to the app icon");
                    if let Some(icon) = app.default_window_icon() {
                        tray = tray.icon(icon.clone());
                    }
                }
            }
            let tray: TrayIcon = tray
                .on_menu_event(move |app, ev| {
                    let shell = menu_shell.clone();
                    match ev.id.as_ref() {
                        "open" => open_window(app, &shell.status_url()),
                        "pause" => {
                            let want = !shell.paused();
                            shell.set_paused(want);
                            let _ = pause_item.set_checked(want);
                            let _ = pause_item.set_text(if want { "Resume protection" } else { "Pause protection" });
                        }
                        "login" => {
                            let installed = service::status().map(|s| s.starts_with("installed")).unwrap_or(false);
                            let r = if installed { service::uninstall() } else { service::install(shell.args.listen) };
                            match r {
                                Ok(msg) => {
                                    tracing::info!("start at login: {msg}");
                                    let _ = login_item.set_checked(!installed);
                                }
                                Err(e) => {
                                    tracing::error!("start at login: {e:#}");
                                    let _ = login_item.set_checked(installed);
                                }
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    }
                })
                .build(app)?;

            // Open the window as soon as the daemon answers, and keep the
            // tooltip current afterwards.
            let handle = app.handle().clone();
            let poll_shell = shell.clone();
            std::thread::spawn(move || {
                for _ in 0..150 {
                    if poll_shell.healthy() {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                let url = poll_shell.status_url();
                let h = handle.clone();
                let _ = handle.run_on_main_thread(move || open_window(&h, &url));
                loop {
                    std::thread::sleep(Duration::from_secs(5));
                    let _ = tray.set_tooltip(Some(tray_tooltip(&poll_shell)));
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("tauri app")
        .run(|_app, event| {
            // Closing the window leaves the firewall and the tray running;
            // Quit is in the tray menu.
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
