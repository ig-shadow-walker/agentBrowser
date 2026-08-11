use std::path::PathBuf;
use std::process::Command;

/// Talking to the agentBrowser engine binary.
///
/// The app deliberately owns no credential storage of its own: every secret
/// operation shells out to the same CLI a user would type. That means the app
/// and the terminal can never disagree about what is stored, and there is no
/// second copy of the storage format to keep in step.
///
/// Step 4 replaces this lookup with a bundled Tauri sidecar. Until then we use
/// whatever `agentbrowser install` put on disk.
const CANDIDATE_DIRS: [&str; 3] = [".local/bin", "/usr/local/bin", "/opt/homebrew/bin"];

#[derive(serde::Serialize)]
pub struct EngineStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub path: Option<String>,
}

pub fn engine_path() -> Option<PathBuf> {
    let home = std::env::var("HOME").ok()?;
    for dir in CANDIDATE_DIRS {
        let candidate = if dir.starts_with('/') {
            PathBuf::from(dir).join("agentbrowser")
        } else {
            PathBuf::from(&home).join(dir).join("agentbrowser")
        };
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
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
    match engine_path() {
        None => EngineStatus { installed: false, version: None, path: None },
        Some(path) => {
            let version = run(&["version"]).ok();
            EngineStatus {
                installed: true,
                version,
                path: Some(path.to_string_lossy().to_string()),
            }
        }
    }
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
