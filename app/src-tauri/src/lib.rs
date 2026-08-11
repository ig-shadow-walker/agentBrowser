mod engine;

use tauri::{
    image::Image,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WindowEvent,
};

#[tauri::command]
fn app_version(app: tauri::AppHandle) -> String {
    let version = app.package_info().version.to_string();
    // Debug-only: lets a headless check confirm the webview really reached Rust.
    // Worth keeping, because a Tauri app whose frontend failed to load still
    // launches and still shows a window — it just shows an empty one.
    #[cfg(debug_assertions)]
    eprintln!("[agentbrowser] app_version called by the webview -> {version}");
    version
}

#[tauri::command]
fn engine_status() -> engine::EngineStatus {
    engine::status()
}

#[tauri::command]
fn secrets_list() -> Result<Vec<String>, String> {
    let result = engine::list_secrets();
    #[cfg(debug_assertions)]
    eprintln!("[agentbrowser] secrets_list -> {result:?}");
    result
}

#[tauri::command]
fn secrets_set(name: String, value: String) -> Result<(), String> {
    engine::set_secret(&name, &value)
}

#[tauri::command]
fn secrets_remove(name: String) -> Result<(), String> {
    engine::remove_secret(&name)
}

fn show_panel(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            app_version,
            engine_status,
            secrets_list,
            secrets_set,
            secrets_remove
        ])
        .setup(|app| {
            // A menu bar utility has no business in the Dock or the app switcher.
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // Logged in release too: when someone reports odd behaviour, the
            // first question is always which engine copy is actually in use.
            match engine::resolve() {
                Some((path, source)) => {
                    eprintln!("[agentbrowser] engine ({source}): {}", path.display())
                }
                None => eprintln!("[agentbrowser] engine not found"),
            }

            let open_item = MenuItem::with_id(app, "open", "Open agentBrowser", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit agentBrowser", true, None::<&str>)?;

            // Shown greyed out, purely as a status readout.
            let status = engine::status();
            let status_label = match (&status.installed, &status.version) {
                (true, Some(v)) => format!("Engine v{v} — ready"),
                (true, None) => "Engine installed".to_string(),
                _ => "Engine not installed".to_string(),
            };
            let status_item = MenuItem::with_id(app, "status", status_label, false, None::<&str>)?;

            let menu = Menu::with_items(
                app,
                &[
                    &status_item,
                    &PredefinedMenuItem::separator(app)?,
                    &open_item,
                    &PredefinedMenuItem::separator(app)?,
                    &quit_item,
                ],
            )?;

            // Template image: black plus alpha, so macOS inverts it for dark mode
            // and menu highlight instead of drawing a fixed-colour blob.
            let icon = Image::from_bytes(include_bytes!("../icons/tray-template.png"))?;

            TrayIconBuilder::with_id("tray")
                .icon(icon)
                .icon_as_template(true)
                .tooltip("agentBrowser")
                .menu(&menu)
                // Keep left-click for the panel; the menu belongs on right-click.
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_panel(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_panel(tray.app_handle());
                    }
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the panel should put the app back in the menu bar, not
            // quit it. Quitting is an explicit choice from the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running agentBrowser");
}
