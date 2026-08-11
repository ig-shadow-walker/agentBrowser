/// Reports the app version so the UI never hardcodes it.
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![app_version])
        .run(tauri::generate_context!())
        .expect("error while running agentBrowser");
}
