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

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};
use uuid::Uuid;

/// Structured RPC failure, distinguishing failure modes the frontend's
/// operation journal (N-22) needs to tell apart -- specifically, whether a
/// turn/start's non-delivery is *certain* (safe to forget) or merely
/// *unknown* (must be kept for reconciliation, since the request may well
/// have reached app-server regardless of what the local error says).
///
///   write_failed     - stdin write itself failed; definitely never sent.
///   server_rejected   - app-server sent back an explicit JSON-RPC error;
///                       definitely processed (and rejected) server-side.
///   response_timeout  - no response within the timeout; unknown.
///   connection_lost   - the connection tore down before a response arrived
///                       (stdout closed, or the oneshot sender was dropped);
///                       unknown.
///   internal_error    - anything else (spawn failure, "not connected",
///                       etc.); treated as unknown by callers that care.
#[derive(Serialize, Clone, Debug)]
pub struct RpcFailure {
    pub kind: &'static str,
    pub message: String,
}

impl RpcFailure {
    fn new(kind: &'static str, message: impl Into<String>) -> Self {
        RpcFailure {
            kind,
            message: message.into(),
        }
    }
}

impl From<String> for RpcFailure {
    fn from(message: String) -> Self {
        RpcFailure::new("internal_error", message)
    }
}

impl From<&str> for RpcFailure {
    fn from(message: &str) -> Self {
        RpcFailure::new("internal_error", message.to_string())
    }
}

pub struct Connection {
    connection_id: String,
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, RpcFailure>>>>,
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
    pub async fn spawn(
        app: AppHandle,
        distro: &str,
        codex_path: &str,
        config_overrides: &[String],
    ) -> Result<Arc<Self>, String> {
        let mut cmd = Command::new("wsl.exe");
        cmd.args(["-d", distro, "--exec", codex_path, "app-server"]);
        // e.g. "model_provider=ollama", "model=gpt-oss:20b" -- never written to
        // config.toml, only applied to this one spawned process (see -c in
        // `codex app-server --help`), so the default provider used by every
        // other codex client on this machine is never touched.
        for kv in config_overrides {
            cmd.arg("-c").arg(kv);
        }
        cmd.stdin(std::process::Stdio::piped())
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
                                    conn.emit_with_id(
                                        &app,
                                        "codex:contamination",
                                        json!({ "line": line }),
                                    );
                                }
                            }
                        }
                        Ok(None) => break, // EOF
                        Err(e) => {
                            conn.emit_with_id(
                                &app,
                                "codex:read-error",
                                json!({ "message": e.to_string() }),
                            );
                            break;
                        }
                    }
                }
                // stdout closed: fail all pending requests with a distinctly
                // kinded "connection_lost" (NOT "server_rejected" -- these
                // requests may well have reached app-server before the
                // connection tore down; the frontend's journal must not
                // treat this as certain non-delivery).
                let mut pending = conn.pending.lock().await;
                for (_, tx) in pending.drain() {
                    let _ = tx.send(Err(RpcFailure::new("connection_lost", "connection closed")));
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
                        // app-server explicitly responded with a JSON-RPC
                        // error: delivery (and processing) is certain.
                        Err(RpcFailure::new("server_rejected", err.to_string()))
                    } else {
                        Ok(msg.get("result").cloned().unwrap_or(Value::Null))
                    };
                    let _ = tx.send(payload);
                    return;
                }
            }
            self.emit_with_id(app, "codex:orphan-response", msg);
        } else {
            self.emit_with_id(
                app,
                "codex:contamination",
                json!({ "line": msg.to_string() }),
            );
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
        stdin
            .flush()
            .await
            .map_err(|e| format!("stdin flush failed: {e}"))
    }

    /// Send a request and await its response (default timeout 120s — turns
    /// respond immediately; completion arrives separately via notification).
    pub async fn request(&self, method: &str, params: Option<Value>) -> Result<Value, RpcFailure> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let mut payload = json!({"id": id, "method": method});
        if let Some(p) = params {
            payload["params"] = p;
        }
        if let Err(e) = self.write_line(&payload).await {
            self.pending.lock().await.remove(&id);
            // The write itself failed -- this request definitely never left
            // the process, so non-delivery is certain.
            return Err(RpcFailure::new("write_failed", e));
        }

        match tokio::time::timeout(std::time::Duration::from_secs(120), rx).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(failure))) => Err(failure), // already correctly kinded by route()/cleanup
            Ok(Err(_)) => {
                // Sender dropped without sending at all (shouldn't normally
                // happen given the cleanup path above, but treat the same
                // way: delivery is unknown, not certain-failed).
                Err(RpcFailure::new(
                    "connection_lost",
                    "connection closed while waiting for response",
                ))
            }
            Err(_) => {
                self.pending.lock().await.remove(&id);
                // We stopped waiting; app-server may still be processing it.
                Err(RpcFailure::new(
                    "response_timeout",
                    format!("timeout waiting for response to {method}"),
                ))
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

    /// Reject a server-initiated request that this client cannot handle.
    pub async fn reject(&self, id: Value, code: i64, message: String) -> Result<(), String> {
        self.write_line(&json!({
            "id": id,
            "error": { "code": code, "message": message }
        }))
        .await
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
