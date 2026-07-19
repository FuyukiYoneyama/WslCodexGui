mod appserver;

use appserver::{Connection, RpcFailure};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, State};
use tokio::sync::Mutex;

/// At most one live app-server connection (primary architecture: the child
/// process is owned by the GUI and always "owned" per N-14).
struct AppState {
    conn: Mutex<Option<Arc<Connection>>>,
}

#[tauri::command]
async fn connect(
    app: AppHandle,
    state: State<'_, AppState>,
    distro: String,
    codex_path: String,
) -> Result<Value, RpcFailure> {
    // Drop any previous connection first.
    if let Some(old) = state.conn.lock().await.take() {
        old.shutdown().await;
    }

    let conn = Connection::spawn(app, &distro, &codex_path)
        .await
        .map_err(RpcFailure::from)?;

    // initialize -> initialized handshake (spec 5.2; mandatory before any
    // other method).
    let init = conn
        .request(
            "initialize",
            Some(json!({
                "clientInfo": {
                    "name": "wsl-codex-gui",
                    "title": "WSL Codex GUI",
                    "version": env!("CARGO_PKG_VERSION"),
                },
                // N-23: stay on the stable API surface (no experimentalApi).
                "capabilities": null,
            })),
        )
        .await?;
    conn.notify("initialized", None).await.map_err(RpcFailure::from)?;

    // Merge connectionId into the response so the frontend can tag its own
    // "current connection" and ignore stale events from a replaced one.
    let mut init = init;
    if let Value::Object(map) = &mut init {
        map.insert("connectionId".into(), json!(conn.connection_id()));
    }

    *state.conn.lock().await = Some(conn);
    Ok(init)
}

#[tauri::command]
async fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    if let Some(conn) = state.conn.lock().await.take() {
        conn.shutdown().await;
    }
    Ok(())
}

/// Generic JSON-RPC passthrough (thread/start, turn/start, thread/list, ...).
/// Keeping the Rust layer thin; schema validation lives in the TS layer which
/// is generated from the pinned codex version (N-10). Returns a structured
/// RpcFailure so the frontend's operation journal (N-22) can tell certain
/// non-delivery (write_failed/server_rejected) apart from unknown delivery
/// (response_timeout/connection_lost) instead of pattern-matching strings.
#[tauri::command]
async fn rpc_request(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, RpcFailure> {
    let conn = state
        .conn
        .lock()
        .await
        .clone()
        .ok_or_else(|| RpcFailure::from("not connected"))?;
    conn.request(&method, params).await
}

/// Answer a server-initiated request (approval decision etc., spec 7.3).
#[tauri::command]
async fn respond_server_request(
    state: State<'_, AppState>,
    id: Value,
    result: Value,
) -> Result<(), String> {
    let conn = state.conn.lock().await.clone().ok_or("not connected")?;
    conn.respond(id, result).await
}

/// F-02a/F-02b: list subdirectories under a registered root, bounded by
/// depth. `root` is passed as a single argv element to `find` (via
/// `--exec`, no shell involved), so it can never be interpreted as shell
/// syntax or break out into additional commands.
#[tauri::command]
async fn list_directories(distro: String, root: String, max_depth: u32) -> Result<Vec<String>, String> {
    let depth = max_depth.max(1).to_string();
    let output = tokio::process::Command::new("wsl.exe")
        .args([
            "-d",
            &distro,
            "--exec",
            "find",
            &root,
            "-mindepth",
            "1",
            "-maxdepth",
            &depth,
            "-type",
            "d",
            "-not",
            "-path",
            "*/.*",
            "-not",
            "-path",
            "*/node_modules*",
            "-not",
            "-path",
            "*/target*",
        ])
        .output()
        .await
        .map_err(|e| format!("failed to run find: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "find under {root} exited with {}: {}",
            output.status,
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut dirs: Vec<String> = stdout
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    dirs.sort();
    Ok(dirs)
}

/// Open an interactive WSL shell at `path` in its own console window.
/// `cmd /c start` detaches the window from this process; `--cd` is a
/// wsl.exe-native flag (no shell string is built from `path`).
#[tauri::command]
fn open_wsl_terminal(distro: String, path: String) -> Result<(), String> {
    std::process::Command::new("cmd.exe")
        .args(["/c", "start", "", "wsl.exe", "-d", &distro, "--cd", &path])
        .spawn()
        .map_err(|e| format!("failed to open WSL terminal: {e}"))?;
    Ok(())
}

/// Open `path` (a Linux path inside `distro`) in Windows Explorer via the
/// \\wsl.localhost\<distro>\... UNC form (spec 7.1).
#[tauri::command]
fn open_in_explorer(distro: String, path: String) -> Result<(), String> {
    let win_path = format!(
        "\\\\wsl.localhost\\{}\\{}",
        distro,
        path.trim_start_matches('/').replace('/', "\\")
    );
    // explorer.exe frequently reports a non-zero exit status even on
    // success; only the spawn itself is a meaningful failure signal here.
    std::process::Command::new("explorer.exe")
        .arg(&win_path)
        .spawn()
        .map_err(|e| format!("failed to open Explorer: {e}"))?;
    Ok(())
}

/// Best-effort resolution of a `net use`-mapped drive letter (e.g. "V") back
/// to its UNC target, by parsing `net use` output for a line naming that
/// drive. Returns None on any parse/exec failure rather than erroring —
/// callers fall back to treating the path as an ordinary local drive.
fn resolve_drive_mapping(drive: &str) -> Option<String> {
    let output = std::process::Command::new("cmd.exe")
        .args(["/c", "net", "use"])
        .output()
        .ok()?;
    let text = String::from_utf8_lossy(&output.stdout);
    let needle = format!("{}:", drive.to_uppercase());
    for line in text.lines() {
        let upper = line.to_uppercase();
        if !upper.contains(&needle) {
            continue;
        }
        if let Some(idx) = line.find("\\\\") {
            if let Some(unc) = line[idx..].split_whitespace().next() {
                return Some(unc.to_string());
            }
        }
    }
    None
}

/// Drag-and-drop support (composer): convert a Windows path (as delivered by
/// the OS file-drop event) to the corresponding WSL Linux path.
///  - `\\wsl.localhost\<distro>\...` / `\\wsl$\<distro>\...` -> `/...`
///  - a drive letter that `net use` maps to one of the above -> `/...`
///  - any other local drive letter -> `/mnt/<letter>/...` (WSL's own
///    auto-mount convention for the Windows filesystem)
#[tauri::command]
fn windows_path_to_wsl(path: String) -> Result<String, String> {
    let normalized = path.replace('/', "\\");

    let strip_wsl_unc = |s: &str| -> Option<String> {
        for prefix in ["\\\\wsl.localhost\\", "\\\\wsl$\\"] {
            if let Some(rest) = s.strip_prefix(prefix) {
                let tail = rest.splitn(2, '\\').nth(1).unwrap_or("");
                return Some(format!("/{}", tail.replace('\\', "/")));
            }
        }
        None
    };

    if let Some(p) = strip_wsl_unc(&normalized) {
        return Ok(p);
    }

    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        let drive = normalized[0..1].to_uppercase();
        let rest = &normalized[2..]; // e.g. "\home\user\file.md"

        if let Some(unc) = resolve_drive_mapping(&drive) {
            let combined = format!("{}{}", unc.trim_end_matches('\\'), rest);
            if let Some(p) = strip_wsl_unc(&combined) {
                return Ok(p);
            }
        }

        let mnt_rest = rest.trim_start_matches('\\').replace('\\', "/");
        return Ok(format!("/mnt/{}/{}", drive.to_lowercase(), mnt_rest));
    }

    Err(format!("unrecognized Windows path: {path}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            conn: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            rpc_request,
            respond_server_request,
            list_directories,
            open_wsl_terminal,
            open_in_explorer,
            windows_path_to_wsl
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
