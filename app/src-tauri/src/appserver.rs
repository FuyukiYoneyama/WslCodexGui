// app-server process management + JSONL codec (spec 5.1-5.3).
//
// Spawns `wsl.exe -d <distro> --exec <codex abs path> app-server` as a child
// process and speaks newline-delimited JSON over its stdin/stdout.
//
// Message routing (JSON-RPC-like framing, per PoC):
//   - has "method" and "id"        -> server-initiated request (approvals etc.)
//                                     forwarded to the frontend as event
//                                     "codex:server-request"; the frontend
//                                     answers via `respond_server_request`.
//   - has "method", no "id"        -> notification; forwarded as event
//                                     "codex:notification".
//   - has "id", result/error       -> response to one of our requests;
//                                     resolves the pending oneshot.
//   - non-JSON line                 -> forwarded as "codex:contamination"
//                                     (spec says this must not happen; surface
//                                     it loudly instead of hiding it).
//
// Every emitted event carries `connectionId` so the frontend can ignore
// stale events from a Connection it has already replaced (e.g. the old
// connection's "disconnected" event arriving after a new `connect()` has
// already succeeded).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

pub struct Connection {
    connection_id: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, Value>>>>,
    next_id: AtomicU64,
}

impl Connection {
    pub fn connection_id(&self) -> &str {
        &self.connection_id
    }

    fn emit_with_id(&self, app: &AppHandle, event: &str, mut payload: Value) {
        if let Value::Object(map) = &mut payload {
            map.insert("connectionId".into(), json!(self.connection_id));
        } else {
            payload = json!({ "connectionId": self.connection_id, "value": payload });
        }
        let _ = app.emit(event, payload);
    }

    /// Spawn the app-server child process and start the reader tasks.
    /// Does NOT run the initialize handshake; the caller does that.
    pub async fn spawn(app: AppHandle, distro: &str, codex_path: &str) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro, "--exec", codex_path, "app-server"])
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        // Prevent a console window flashing up on Windows.
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("failed to spawn wsl.exe: {e}"))?;

        let stdin = child.stdin.take().ok_or("no stdin handle")?;
        let stdout = child.stdout.take().ok_or("no stdout handle")?;
        let stderr = child.stderr.take().ok_or("no stderr handle")?;

        let conn = Arc::new(Connection {
            connection_id: Uuid::new_v4().to_string(),
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
        });

        // stdout reader: JSONL parse + route. Draining continuously is
        // load-bearing (N-19): an unread pipe eventually blocks the child.
        {
            let conn = conn.clone();
            let app = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(line)) => {
                            if line.trim().is_empty() {
                                continue;
                            }
                            match serde_json::from_str::<Value>(&line) {
                                Ok(msg) => conn.route(&app, msg).await,
                                Err(_) => {
                                    conn.emit_with_id(&app, "codex:contamination", json!({ "line": line }));
                                }
                            }
                        }
                        Ok(None) => break, // EOF
                        Err(e) => {
                            conn.emit_with_id(&app, "codex:read-error", json!({ "message": e.to_string() }));
                            break;
                        }
                    }
                }
                // stdout closed: fail all pending requests, notify frontend.
                let mut pending = conn.pending.lock().await;
                for (_, tx) in pending.drain() {
                    let _ = tx.send(Err(json!({"message": "connection closed"})));
                }
                drop(pending);
                conn.emit_with_id(&app, "codex:disconnected", json!({}));
            });
        }

        // stderr reader (N-19): forward as diagnostic events.
        {
            let conn = conn.clone();
            let app = app.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    conn.emit_with_id(&app, "codex:stderr", json!({ "line": line }));
                }
            });
        }

        Ok(conn)
    }

    async fn route(&self, app: &AppHandle, msg: Value) {
        let has_method = msg.get("method").is_some();
        let has_id = msg.get("id").is_some();
        if has_method && has_id {
            // Server-initiated request (approval etc.) — frontend must answer.
            self.emit_with_id(app, "codex:server-request", msg);
        } else if has_method {
            self.emit_with_id(app, "codex:notification", msg);
        } else if has_id {
            let id = msg.get("id").and_then(Value::as_u64);
            if let Some(id) = id {
                if let Some(tx) = self.pending.lock().await.remove(&id) {
                    let payload = if let Some(err) = msg.get("error") {
                        Err(err.clone())
                    } else {
                        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(payload);
                    return;
                }
            }
            self.emit_with_id(app, "codex:orphan-response", msg);
        } else {
            self.emit_with_id(app, "codex:contamination", json!({ "line": msg.to_string() }));
        }
    }

    async fn write_line(&self, value: &Value) -> Result<(), String> {
        let mut line = value.to_string();
        line.push('\n');
        let mut stdin = self.stdin.lock().await;
        stdin
            .write_all(line.as_bytes())
            .await
            .map_err(|e| format!("stdin write failed: {e}"))?;
        stdin.flush().await.map_err(|e| format!("stdin flush failed: {e}"))
    }

    /// Send a request and await its response (default timeout 120s — turns
    /// respond immediately; completion arrives separately via notification).
    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let mut payload = json!({"id": id, "method": method});
        if let Some(p) = params {
            payload["params"] = p;
        }
        if let Err(e) = self.write_line(&payload).await {
            self.pending.lock().await.remove(&id);
            return Err(e);
        }

        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(err))) => Err(err.to_string()),
            Ok(Err(_)) => Err("connection closed while waiting for response".into()),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(format!("timeout waiting for response to {method}"))
            }
        }
    }

    pub async fn notify(&self, method: &str, params: Option<Value>) -> Result<(), String> {
        let mut payload = json!({"method": method});
        if let Some(p) = params {
            payload["params"] = p;
        }
        self.write_line(&payload).await
    }

    /// Answer a server-initiated request (approval decision etc.).
    /// `id` is passed through verbatim (RequestId may be string or number).
    pub async fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        self.write_line(&json!({"id": id, "result": result})).await
    }

    /// Graceful shutdown: close stdin (EOF) and wait briefly; kill if needed.
    pub async fn shutdown(&self) {
        {
            let mut stdin = self.stdin.lock().await;
            let _ = stdin.shutdown().await;
        }
        let mut child = self.child.lock().await;
        match tokio::time::timeout(std::time::Duration::from_secs(5), child.wait()).await {
            Ok(_) => {}
            Err(_) => {
                let _ = child.kill().await;
            }
        }
    }
}
