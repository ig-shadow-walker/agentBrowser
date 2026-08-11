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
    /// "missing" when nothing is on PATH, "different" when the bytes differ.
    /// Lets the UI say which problem it is instead of guessing.
    pub reason: Option<&'static str>,
}

/// The copy inside this app bundle, ignoring anything on PATH.
fn bundled_engine() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    for name in [String::from("agentbrowser"), format!("agentbrowser-{}", target_triple())] {
        let candidate = dir.join(name);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn hash_file(path: &PathBuf) -> Option<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;

    let mut file = std::fs::File::open(path).ok()?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer).ok()?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Some(hasher.finalize().iter().map(|b| format!("{b:02x}")).collect())
}

/// Whether two files hold the same bytes.
///
/// Compares length first, which settles most cases for free; only identical
/// lengths are worth hashing. Hashing 72MB costs about 200ms, so this keeps the
/// common answer instant.
fn same_contents(a: &PathBuf, b: &PathBuf) -> bool {
    let (Ok(meta_a), Ok(meta_b)) = (std::fs::metadata(a), std::fs::metadata(b)) else {
        return false;
    };
    if meta_a.len() != meta_b.len() {
        return false;
    }
    match (hash_file(a), hash_file(b)) {
        (Some(ha), Some(hb)) => ha == hb,
        _ => false,
    }
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

/// Setup is needed when nothing is on PATH, or when what is there is not the
/// same binary this app ships. An agent silently launching a stale engine is the
/// failure this exists to catch.
///
/// This compares *contents*, not version strings, on purpose. A version-based
/// check only works if every change remembers to bump the version, and the one
/// time it is forgotten the app confidently reports "up to date" while agents run
/// something else. Comparing bytes needs no discipline to stay correct.
pub fn setup_status() -> SetupStatus {
    let bundled = bundled_engine();
    let installed = installed_cli();

    let bundled_version = bundled.as_ref().and_then(version_of);
    let installed_version = installed.as_ref().and_then(version_of);

    let (needs_setup, reason) = match (&bundled, &installed) {
        // No bundled engine means this is a dev run; nothing to offer.
        (None, _) => (false, None),
        (Some(_), None) => (true, Some("missing")),
        (Some(b), Some(i)) => {
            if same_contents(b, i) {
                (false, None)
            } else {
                (true, Some("different"))
            }
        }
    };

    SetupStatus { bundled_version, installed_version, needs_setup, reason }
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
