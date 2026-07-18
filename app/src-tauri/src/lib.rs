mod appserver;

use appserver::Connection;
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
) -> Result<Value, String> {
    // Drop any previous connection first.
    if let Some(old) = state.conn.lock().await.take() {
        old.shutdown().await;
    }

    let conn = Connection::spawn(app, &distro, &codex_path).await?;

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
    conn.notify("initialized", None).await?;

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
/// is generated from the pinned codex version (N-10).
#[tauri::command]
async fn rpc_request(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let conn = state.conn.lock().await.clone().ok_or("not connected")?;
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
            respond_server_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
