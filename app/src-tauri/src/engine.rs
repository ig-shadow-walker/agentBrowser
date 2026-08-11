use std::path::PathBuf;
use std::process::Command;

/// Talking to the agentBrowser engine binary.
///
/// The app deliberately owns no credential storage of its own: every secret
/// operation shells out to the same CLI a user would type. That means the app
/// and the terminal can never disagree about what is stored, and there is no
/// second copy of the storage format to keep in step.
///
/// The frontend never runs anything itself — it calls the typed commands in
/// lib.rs. That is why this uses `std::process::Command` rather than Tauri's
/// shell plugin: granting the webview a general shell-execute permission would
/// be a much wider surface than this needs.
const INSTALL_DIRS: [&str; 3] = [".local/bin", "/usr/local/bin", "/opt/homebrew/bin"];

#[derive(serde::Serialize)]
pub struct EngineStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
    /// "bundled" | "installed" | "dev" — surfaced so it is obvious which copy
    /// is in use when something behaves unexpectedly.
    pub source: Option<String>,
}

/// The Rust target triple, used to find an unbundled sidecar during development.
fn target_triple() -> String {
    format!("{}-apple-darwin", std::env::consts::ARCH)
}

/// Where the engine is, and which copy it is.
///
/// Ordered deliberately: the copy shipped inside this app wins, so the app is
/// self-contained and its behaviour cannot drift with whatever happens to be on
/// PATH. Only if there is no bundled copy do we fall back.
pub fn resolve() -> Option<(PathBuf, &'static str)> {
    // 1. Bundled sidecar. Tauri strips the triple when bundling, so the file
    //    sits next to the app binary as plain `agentbrowser`; check the
    //    suffixed name too, for a sidecar that has not been through bundling.
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for name in [String::from("agentbrowser"), format!("agentbrowser-{}", target_triple())] {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some((candidate, "bundled"));
                }
            }
        }
    }

    // 2. Whatever `agentbrowser install` put on PATH.
    if let Ok(home) = std::env::var("HOME") {
        for dir in INSTALL_DIRS {
            let candidate = if dir.starts_with('/') {
                PathBuf::from(dir).join("agentbrowser")
            } else {
                PathBuf::from(&home).join(dir).join("agentbrowser")
            };
            if candidate.is_file() {
                return Some((candidate, "installed"));
            }
        }
    }

    // 3. Repo build output, so `npm run tauri dev` works without installing.
    let arch = if std::env::consts::ARCH == "aarch64" { "arm64" } else { "x64" };
    if let Ok(exe) = std::env::current_exe() {
        // target/debug/agentbrowser-app -> repo root is four levels up.
        if let Some(repo) = exe.ancestors().nth(4) {
            let candidate = repo.join("build").join(format!("agentbrowser-darwin-{arch}"));
            if candidate.is_file() {
                return Some((candidate, "dev"));
            }
        }
    }

    None
}

pub fn engine_path() -> Option<PathBuf> {
    resolve().map(|(path, _)| path)
}

/// Runs the engine and returns stdout, or a message suitable for showing a user.
pub fn run(args: &[&str]) -> Result<String, String> {
    let binary = engine_path().ok_or_else(|| {
        "agentBrowser engine not found. Install it first, then reopen this window.".to_string()
    })?;

    let output = Command::new(&binary)
        .args(args)
        .output()
        .map_err(|e| format!("Could not run the engine: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        // The CLI reports user-facing problems on stderr; fall back to stdout
        // so an error never surfaces as an empty string.
        let message = if !stderr.is_empty() { stderr } else { stdout };
        return Err(if message.is_empty() {
            format!("Engine exited with {}", output.status)
        } else {
            message
        });
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

pub fn status() -> EngineStatus {
    match resolve() {
        None => EngineStatus { installed: false, version: None, path: None, source: None },
        Some((path, source)) => EngineStatus {
            installed: true,
            version: run(&["version"]).ok(),
            path: Some(path.to_string_lossy().to_string()),
            source: Some(source.to_string()),
        },
    }
}

#[derive(serde::Serialize)]
pub struct SetupStatus {
    /// Version of the copy shipped inside this app.
    pub bundled_version: Option<String>,
    /// Version of the copy on PATH, if any — what Claude Code and Codex run.
    pub installed_version: Option<String>,
    pub needs_setup: bool,
}

/// The copy on PATH specifically, ignoring the bundled one.
fn installed_cli() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    INSTALL_DIRS
        .iter()
        .map(|dir| {
            if dir.starts_with('/') {
                PathBuf::from(dir).join("agentbrowser")
            } else {
                PathBuf::from(&home).join(dir).join("agentbrowser")
            }
        })
        .find(|p| p.is_file())
}

fn version_of(binary: &PathBuf) -> Option<String> {
    let output = Command::new(binary).arg("version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if v.is_empty() { None } else { Some(v) }
}

/// Setup is needed when nothing is on PATH, or what is there is a different
/// version from the copy this app ships — an agent launching a stale engine is
/// the failure this catches.
pub fn setup_status() -> SetupStatus {
    let bundled_version = engine_path().as_ref().and_then(version_of);
    let installed_version = installed_cli().as_ref().and_then(version_of);

    let needs_setup = match (&bundled_version, &installed_version) {
        (Some(bundled), Some(installed)) => bundled != installed,
        (Some(_), None) => true,
        // No bundled engine means this is a dev run; nothing to offer.
        (None, _) => false,
    };

    SetupStatus { bundled_version, installed_version, needs_setup }
}

/// Runs the engine's own installer: copies itself onto PATH, makes sure a
/// browser is available, and registers with Claude Code and Codex. Reusing the
/// CLI's flow means there is exactly one implementation of "install", already
/// covered by the engine's test suite.
pub fn run_setup() -> Result<String, String> {
    run(&["install"])
}

pub fn list_secrets() -> Result<Vec<String>, String> {
    let raw = run(&["secrets", "list", "--json"])?;
    serde_json::from_str::<Vec<String>>(&raw)
        .map_err(|e| format!("Could not read the secret list: {e}"))
}

pub fn set_secret(name: &str, value: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("Give the credential a name.".into());
    }
    if value.is_empty() {
        return Err("Give the credential a value.".into());
    }
    // Passed as separate argv entries, never interpolated into a shell string,
    // so quoting and shell metacharacters in a password cannot cause trouble.
    run(&["secrets", "set", name, value]).map(|_| ())
}

pub fn remove_secret(name: &str) -> Result<(), String> {
    run(&["secrets", "rm", name]).map(|_| ())
}
