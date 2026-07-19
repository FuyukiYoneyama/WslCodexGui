mod appserver;

use appserver::{Connection, RpcFailure};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
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
    config_overrides: Vec<String>,
) -> Result<Value, RpcFailure> {
    // Drop any previous connection first.
    if let Some(old) = state.conn.lock().await.take() {
        old.shutdown().await;
    }

    let conn = Connection::spawn(app, &distro, &codex_path, &config_overrides)
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

#[derive(serde::Serialize)]
struct OllamaModelInfo {
    name: String,
    context_length: Option<u64>,
}

/// List locally pulled Ollama models (name + real context length) from
/// Ollama's native /api/tags (not the OpenAI-compat /v1/models codex itself
/// queries, which is why codex falls back to generic metadata for unknown
/// models and its own model/list is unusable here). Runs via curl.exe rather
/// than an HTTP client crate: browser fetch() from the webview hits Ollama's
/// CORS restrictions, but curl.exe -> Ollama (both on Windows) isn't a
/// cross-origin request at all.
#[tauri::command]
async fn list_ollama_models() -> Result<Vec<OllamaModelInfo>, String> {
    let output = tokio::process::Command::new("curl.exe")
        .args(["-s", "http://localhost:11434/api/tags"])
        .output()
        .await
        .map_err(|e| format!("failed to run curl.exe: {e}"))?;
    if !output.status.success() {
        return Err(format!("curl.exe exited with {}", output.status));
    }
    let body = String::from_utf8_lossy(&output.stdout);
    let json: Value = serde_json::from_str(&body).map_err(|e| format!("invalid JSON from Ollama: {e}"))?;
    let models = json
        .get("models")
        .and_then(|v| v.as_array())
        .ok_or("unexpected response shape from Ollama /api/tags")?;
    let mut result: Vec<OllamaModelInfo> = models
        .iter()
        .filter_map(|m| {
            let name = m.get("name").and_then(|v| v.as_str())?.to_string();
            let context_length = m
                .get("details")
                .and_then(|d| d.get("context_length"))
                .and_then(|v| v.as_u64());
            Some(OllamaModelInfo { name, context_length })
        })
        .collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
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
        // Must be registered first (tauri-plugin-single-instance requirement).
        // A second launch hands its argv/cwd to this callback instead of
        // starting its own WebView2/app-server -- avoids the localStorage
        // journal race and duplicate app-server processes from running two
        // windows against the same thread.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState {
            conn: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            rpc_request,
            respond_server_request,
            open_wsl_terminal,
            open_in_explorer,
            windows_path_to_wsl,
            list_ollama_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
