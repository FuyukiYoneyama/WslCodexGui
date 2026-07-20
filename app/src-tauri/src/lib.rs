mod appserver;

use appserver::{Connection, RpcFailure};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::Mutex;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

fn validate_distro(distro: &str) -> Result<(), String> {
    if distro.trim().is_empty()
        || distro.chars().any(|c| {
            c.is_control() || matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
        })
    {
        return Err("invalid WSL distribution name".into());
    }
    Ok(())
}

fn pasted_image_filename(path: &str) -> Result<&str, String> {
    let filename = path
        .strip_prefix("/tmp/")
        .ok_or("pasted image path is outside /tmp")?;
    let generated = filename
        .strip_prefix("wslcodexgui-paste-")
        .ok_or("not a WslCodexGui pasted image path")?;
    let (uuid, ext) = generated
        .rsplit_once('.')
        .ok_or("invalid WslCodexGui pasted image filename")?;
    if filename.contains(['/', '\\'])
        || uuid::Uuid::parse_str(uuid).is_err()
        || ext.is_empty()
        || ext.len() > 10
        || !ext.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err("not a WslCodexGui pasted image path".into());
    }
    Ok(filename)
}

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
    let init = match conn
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
        .await
    {
        Ok(init) => init,
        Err(error) => {
            conn.shutdown().await;
            return Err(error);
        }
    };
    if let Err(error) = conn.notify("initialized", None).await {
        conn.shutdown().await;
        return Err(RpcFailure::from(error));
    }

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

/// Return a JSON-RPC error for a server request this GUI does not support.
#[tauri::command]
async fn reject_server_request(
    state: State<'_, AppState>,
    id: Value,
    code: i64,
    message: String,
) -> Result<(), String> {
    let conn = state.conn.lock().await.clone().ok_or("not connected")?;
    conn.reject(id, code, message).await
}

/// Write a pasted clipboard image to a WSL temp file and return its Linux
/// path, so it can be attached to a turn as UserInput's `localImage`
/// (app-server runs inside WSL and can't read a Windows clipboard/path
/// directly). Writing through the \\wsl.localhost UNC form is the same
/// approach already used to edit files inside WSL from Rust elsewhere in
/// this app (no shell/wsl.exe invocation needed for a plain file write).
#[tauri::command]
async fn save_pasted_image(distro: String, bytes: Vec<u8>, ext: String) -> Result<String, String> {
    validate_distro(&distro)?;
    if ext.is_empty() || ext.len() > 10 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid pasted image extension".into());
    }
    let filename = format!("wslcodexgui-paste-{}.{}", uuid::Uuid::new_v4(), ext);
    let win_path = format!("\\\\wsl.localhost\\{distro}\\tmp\\{filename}");
    tokio::fs::write(&win_path, &bytes)
        .await
        .map_err(|e| format!("failed to write pasted image: {e}"))?;
    Ok(format!("/tmp/{filename}"))
}

/// Remove only files created by `save_pasted_image`; arbitrary WSL paths are
/// deliberately rejected so the frontend cannot turn this into a delete API.
#[tauri::command]
async fn delete_pasted_image(distro: String, path: String) -> Result<(), String> {
    validate_distro(&distro)?;
    let filename = pasted_image_filename(&path)?;
    let win_path = format!("\\\\wsl.localhost\\{distro}\\tmp\\{filename}");
    match tokio::fs::remove_file(&win_path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("failed to delete pasted image: {error}")),
    }
}

/// Open an interactive WSL shell at `path` in its own console window.
/// `wsl.exe` is started directly so neither `path` nor `distro` is parsed by
/// cmd.exe. CREATE_NEW_CONSOLE gives the interactive shell its own window.
#[tauri::command]
fn open_wsl_terminal(distro: String, path: String) -> Result<(), String> {
    validate_distro(&distro)?;
    if !path.starts_with('/') {
        return Err("WSL terminal path must be absolute".into());
    }
    let mut command = std::process::Command::new("wsl.exe");
    command.args(["-d", &distro, "--cd", &path]);
    #[cfg(windows)]
    command.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
    command
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
    let json: Value =
        serde_json::from_str(&body).map_err(|e| format!("invalid JSON from Ollama: {e}"))?;
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
            Some(OllamaModelInfo {
                name,
                context_length,
            })
        })
        .collect();
    result.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(result)
}

/// Open `path` (a Linux path inside `distro`) in Windows Explorer via the
/// \\wsl.localhost\<distro>\... UNC form (spec 7.1).
#[tauri::command]
fn open_in_explorer(distro: String, path: String) -> Result<(), String> {
    validate_distro(&distro)?;
    if !path.starts_with('/') {
        return Err("Explorer path must be an absolute WSL path".into());
    }
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

/// Open Explorer with `path` (a Linux path inside `distro`) selected within
/// its containing folder, via the \\wsl.localhost\<distro>\... UNC form.
/// Deliberately spawns explorer.exe as a plain process (same as
/// open_in_explorer) rather than going through the opener plugin's
/// revealItemInDir, which calls a COM shell API in-process and produced a
/// window that rendered solid black until it lost and regained focus.
#[tauri::command]
fn reveal_in_explorer(distro: String, path: String) -> Result<(), String> {
    validate_distro(&distro)?;
    if !path.starts_with('/') {
        return Err("Explorer path must be an absolute WSL path".into());
    }
    let win_path = format!(
        "\\\\wsl.localhost\\{}\\{}",
        distro,
        path.trim_start_matches('/').replace('/', "\\")
    );
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{win_path}"))
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
fn strip_wsl_unc(s: &str, expected_distro: &str) -> Result<Option<String>, String> {
    let lower = s.to_ascii_lowercase();
    for prefix in ["\\\\wsl.localhost\\", "\\\\wsl$\\"] {
        if lower.starts_with(prefix) {
            let rest = &s[prefix.len()..];
            let mut parts = rest.splitn(2, '\\');
            let actual_distro = parts.next().unwrap_or("");
            if !actual_distro.eq_ignore_ascii_case(expected_distro) {
                return Err(format!(
                    "path belongs to WSL distribution '{actual_distro}', not '{expected_distro}'"
                ));
            }
            let tail = parts.next().unwrap_or("");
            return Ok(Some(format!("/{}", tail.replace('\\', "/"))));
        }
    }
    Ok(None)
}

#[tauri::command]
fn windows_path_to_wsl(path: String, distro: String) -> Result<String, String> {
    validate_distro(&distro)?;
    let mut normalized = path.replace('/', "\\");
    // Explorer includes a trailing separator when the dropped item is a
    // folder (unlike files); strip it so the converted path doesn't end up
    // with a spurious trailing slash. `> 3` keeps a bare drive root like
    // "C:\" intact.
    while normalized.len() > 3 && normalized.ends_with('\\') {
        normalized.pop();
    }

    if let Some(p) = strip_wsl_unc(&normalized, &distro)? {
        return Ok(p);
    }

    if normalized.len() >= 2 && normalized.as_bytes()[1] == b':' {
        let drive = normalized[0..1].to_uppercase();
        let rest = &normalized[2..]; // e.g. "\home\user\file.md"

        if let Some(unc) = resolve_drive_mapping(&drive) {
            let combined = format!("{}{}", unc.trim_end_matches('\\'), rest);
            if let Some(p) = strip_wsl_unc(&combined, &distro)? {
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
            reject_server_request,
            open_wsl_terminal,
            open_in_explorer,
            reveal_in_explorer,
            save_pasted_image,
            delete_pasted_image,
            windows_path_to_wsl,
            list_ollama_models
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{pasted_image_filename, strip_wsl_unc, validate_distro};

    #[test]
    fn unc_path_for_selected_distro_is_converted() {
        let converted = strip_wsl_unc(
            r"\\wsl.localhost\Ubuntu-24.04\home\user\project",
            "Ubuntu-24.04",
        )
        .unwrap();
        assert_eq!(converted.as_deref(), Some("/home/user/project"));
    }

    #[test]
    fn unc_path_for_another_distro_is_rejected() {
        let error = strip_wsl_unc(
            r"\\wsl.localhost\Ubuntu\home\user\project",
            "Ubuntu-24.04",
        )
        .unwrap_err();
        assert!(error.contains("Ubuntu"));
        assert!(error.contains("Ubuntu-24.04"));
    }

    #[test]
    fn unc_prefix_and_distro_match_case_insensitively() {
        let converted = strip_wsl_unc(r"\\WSL$\ubuntu\tmp\x", "Ubuntu").unwrap();
        assert_eq!(converted.as_deref(), Some("/tmp/x"));
    }

    #[test]
    fn pasted_image_delete_scope_is_narrow() {
        let valid = "/tmp/wslcodexgui-paste-550e8400-e29b-41d4-a716-446655440000.png";
        assert_eq!(
            pasted_image_filename(valid).unwrap(),
            "wslcodexgui-paste-550e8400-e29b-41d4-a716-446655440000.png"
        );
        assert!(pasted_image_filename("/tmp/unrelated.png").is_err());
        assert!(pasted_image_filename("/home/user/wslcodexgui-paste-1234.png").is_err());
        assert!(pasted_image_filename("/tmp/wslcodexgui-paste-not-a-uuid.png").is_err());
        assert!(pasted_image_filename("/tmp/wslcodexgui-paste-dir/file.png").is_err());
    }

    #[test]
    fn invalid_distro_components_are_rejected() {
        assert!(validate_distro("Ubuntu-24.04").is_ok());
        assert!(validate_distro("").is_err());
        assert!(validate_distro("Ubuntu\\other").is_err());
        assert!(validate_distro("Ubuntu&cmd").is_ok());
    }
}
