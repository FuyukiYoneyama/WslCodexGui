mod appserver;

use appserver::{Connection, RpcFailure};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::{AppHandle, State};
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

/// Native-mode counterpart to `pasted_image_filename`: validates that `path`
/// is a WslCodexGui-generated pasted-image file sitting directly inside the
/// Windows temp directory (same generated-filename shape, different root),
/// so `delete_pasted_image` can't be turned into an arbitrary-file-delete API
/// in native mode either.
fn pasted_image_filename_native(path: &str) -> Result<String, String> {
    let temp_dir = std::env::temp_dir();
    let path_buf = std::path::Path::new(path);
    if path_buf.parent() != Some(temp_dir.as_path()) {
        return Err("pasted image path is outside the temp directory".into());
    }
    let filename = path_buf
        .file_name()
        .and_then(|f| f.to_str())
        .ok_or("invalid pasted image filename")?;
    let generated = filename
        .strip_prefix("wslcodexgui-paste-")
        .ok_or("not a WslCodexGui pasted image path")?;
    let (uuid, ext) = generated
        .rsplit_once('.')
        .ok_or("invalid WslCodexGui pasted image filename")?;
    if uuid::Uuid::parse_str(uuid).is_err()
        || ext.is_empty()
        || ext.len() > 10
        || !ext.chars().all(|c| c.is_ascii_alphanumeric())
    {
        return Err("not a WslCodexGui pasted image path".into());
    }
    Ok(filename.to_string())
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
    connection_mode: String,
    distro: String,
    codex_path: String,
    config_overrides: Vec<String>,
    use_ollama: bool,
) -> Result<Value, RpcFailure> {
    // Resolve the endpoint from the app-server's execution environment. The
    // Windows-side model-list route is deliberately separate and always uses
    // Windows loopback; a WSL app-server may instead need the NAT gateway.
    let ollama_codex_base_url = if use_ollama {
        Some(
            resolve_ollama_codex_base_url(&connection_mode, &distro)
                .await
                .map_err(RpcFailure::from)?,
        )
    } else {
        None
    };

    // Drop any previous connection first.
    if let Some(old) = state.conn.lock().await.take() {
        old.shutdown().await;
    }

    let conn = Connection::spawn(
        app,
        &connection_mode,
        &distro,
        &codex_path,
        &config_overrides,
        ollama_codex_base_url.as_deref(),
    )
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
async fn save_pasted_image(
    connection_mode: String,
    distro: String,
    bytes: Vec<u8>,
    ext: String,
) -> Result<String, String> {
    if ext.is_empty() || ext.len() > 10 || !ext.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err("invalid pasted image extension".into());
    }
    let filename = format!("wslcodexgui-paste-{}.{}", uuid::Uuid::new_v4(), ext);
    if connection_mode == "native" {
        // Native mode: app-server runs directly on Windows, so the pasted
        // image can live in the ordinary Windows temp dir and be attached
        // via its plain Windows path -- no /tmp or WSL UNC involved.
        let win_path = std::env::temp_dir().join(&filename);
        tokio::fs::write(&win_path, &bytes)
            .await
            .map_err(|e| format!("failed to write pasted image: {e}"))?;
        return Ok(win_path.to_string_lossy().into_owned());
    }
    validate_distro(&distro)?;
    let win_path = format!("\\\\wsl.localhost\\{distro}\\tmp\\{filename}");
    tokio::fs::write(&win_path, &bytes)
        .await
        .map_err(|e| format!("failed to write pasted image: {e}"))?;
    Ok(format!("/tmp/{filename}"))
}

/// Remove only files created by `save_pasted_image`; arbitrary paths are
/// deliberately rejected so the frontend cannot turn this into a delete API.
#[tauri::command]
async fn delete_pasted_image(
    connection_mode: String,
    distro: String,
    path: String,
) -> Result<(), String> {
    if connection_mode == "native" {
        let filename = pasted_image_filename_native(&path)?;
        let win_path = std::env::temp_dir().join(filename);
        return match tokio::fs::remove_file(&win_path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!("failed to delete pasted image: {error}")),
        };
    }
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
struct WslDistro {
    name: String,
    is_default: bool,
}

/// wsl.exe's management output (`-l -v` etc.) is UTF-16LE by default; output
/// from commands run *inside* a distro is plain UTF-8. WSL_UTF8=1 forces
/// management output to UTF-8 on recent WSL builds, but older builds ignore
/// it, so sniff for the NUL bytes UTF-16LE ASCII text is full of and decode
/// accordingly instead of trusting either encoding blindly.
fn decode_wsl_output(bytes: &[u8]) -> String {
    if bytes.iter().take(64).any(|&b| b == 0) {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Enumerate installed WSL distributions with the default one marked.
/// Parses `wsl.exe -l -v` rather than `-l` because the default marker there
/// is a locale-independent `*` prefix (plain `-l` appends a localized
/// "(Default)"/"(既定)" suffix that can't be matched reliably).
#[tauri::command]
async fn list_wsl_distros() -> Result<Vec<WslDistro>, String> {
    let mut cmd = tokio::process::Command::new("wsl.exe");
    cmd.args(["-l", "-v"]).env("WSL_UTF8", "1");
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run wsl.exe: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "wsl.exe -l -v failed: {}",
            decode_wsl_output(&output.stdout).trim()
        ));
    }
    let text = decode_wsl_output(&output.stdout);
    let mut distros = Vec::new();
    // Skip the (localized) header line; rows look like
    // "* Ubuntu-24.04    Running    2" / "  Debian    Stopped    2".
    for line in text.lines().skip(1) {
        let line = line.trim_matches(|c: char| c.is_whitespace() || c == '\u{0}');
        if line.is_empty() {
            continue;
        }
        let is_default = line.starts_with('*');
        let rest = line.trim_start_matches('*').trim_start();
        let Some(name) = rest.split_whitespace().next() else {
            continue;
        };
        distros.push(WslDistro {
            name: name.to_string(),
            is_default,
        });
    }
    if distros.is_empty() {
        return Err("no WSL distributions found".into());
    }
    // Default first, rest in wsl.exe's own order.
    distros.sort_by_key(|d| !d.is_default);
    Ok(distros)
}

/// Locate the codex executable inside `distro`. Tries an interactive login
/// bash first (nvm-installed codex is only on PATH once ~/.bashrc's nvm
/// block runs, which non-interactive shells skip), then falls back to
/// globbing the usual install locations directly.
///
/// Always invoke via `--exec` (not `--`, see `wsl_exec_args` below):
/// without it, `wsl.exe` runs its own environment initialization (sourcing
/// `/etc/profile` etc.) *before* handing off to the requested command, which
/// then runs its own login-shell initialization again via `bash -lic` --
/// two initialization passes that can step on each other. Confirmed on a
/// real machine where codex was unreachable through this detection path
/// even though the same distro's own interactive terminal (opened directly,
/// not through this app) could run `codex` fine -- `--exec` skips wsl.exe's
/// own pass and leaves `bash -lic` as the sole source of truth for PATH.
fn wsl_exec_args<'a>(distro: &'a str, command_args: &'a [&'a str]) -> Vec<&'a str> {
    let mut args = Vec::with_capacity(3 + command_args.len());
    args.extend(["-d", distro, "--exec"]);
    args.extend_from_slice(command_args);
    args
}

#[tauri::command]
async fn detect_codex_path(distro: String) -> Result<Option<String>, String> {
    validate_distro(&distro)?;

    // Login shells print MOTD banners to stdout before the command output,
    // and MOTD lines can start with '/' (".hushlogin" hints etc.), so the
    // real answer is tagged with a marker no banner will ever contain.
    const MARKER: &str = "__WSLCODEXGUI__";

    async fn run_in_distro(distro: &str, shell_args: &[&str]) -> Option<String> {
        let mut cmd = tokio::process::Command::new("wsl.exe");
        cmd.args(wsl_exec_args(distro, shell_args));
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let output = cmd.output().await.ok()?;
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .filter_map(|l| l.trim().strip_prefix(MARKER))
            .map(str::trim)
            // A /mnt/... hit is Windows' own npm shim leaking in through
            // appendWindowsPath — not a Linux codex, so never auto-pick it
            // (spawning it via `wsl --exec` doesn't reliably work).
            .find(|p| p.starts_with('/') && !p.starts_with("/mnt/"))
            .map(str::to_string)
    }

    let probe = format!(r#"echo "{MARKER}$(command -v codex)""#);
    if let Some(path) = run_in_distro(&distro, &["bash", "-lic", &probe]).await {
        return Ok(Some(path));
    }
    let fallback = format!(
        r#"for p in "$HOME"/.nvm/versions/node/*/bin/codex "$HOME"/.local/bin/codex "$HOME"/.local/share/pnpm/codex "$HOME"/.yarn/bin/codex /usr/local/bin/codex /usr/bin/codex; do if [ -x "$p" ]; then echo "{MARKER}$p"; break; fi; done"#
    );
    if let Some(path) = run_in_distro(&distro, &["sh", "-c", &fallback]).await {
        return Ok(Some(path));
    }
    Ok(None)
}

/// Check that `path` is an executable file inside `distro` (used to validate
/// a hand-entered codex path before enabling the connect button).
#[tauri::command]
async fn verify_codex_path(distro: String, path: String) -> Result<bool, String> {
    validate_distro(&distro)?;
    if !path.starts_with('/') || path.contains('\u{0}') {
        return Ok(false);
    }
    let mut cmd = tokio::process::Command::new("wsl.exe");
    let command_args = ["test", "-x", path.as_str()];
    cmd.args(wsl_exec_args(&distro, &command_args));
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    let output = cmd
        .output()
        .await
        .map_err(|e| format!("failed to run wsl.exe: {e}"))?;
    Ok(output.status.success())
}

/// Locate a natively-installed Windows codex via `where`, mirroring
/// `detect_codex_path`'s role for WSL. `where codex` lists every PATHEXT
/// match; `codex.cmd` (the npm-installed shim) is preferred since that's the
/// form verified to work when wrapped in `cmd.exe /c` by `Connection::spawn`.
#[tauri::command]
async fn detect_codex_path_native() -> Result<Option<String>, String> {
    async fn where_first(needle: &str) -> Option<String> {
        let mut cmd = tokio::process::Command::new("cmd.exe");
        cmd.args(["/c", "where", needle]);
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        let output = cmd.output().await.ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .lines()
            .map(str::trim)
            .find(|l| !l.is_empty())
            .map(str::to_string)
    }

    if let Some(path) = where_first("codex.cmd").await {
        return Ok(Some(path));
    }
    if let Some(path) = where_first("codex.exe").await {
        return Ok(Some(path));
    }
    Ok(None)
}

/// Check that `path` is a file on disk (used to validate a hand-entered
/// native codex path before enabling the connect button). Executability
/// can't be checked cheaply on Windows the way `test -x` does on WSL, so this
/// only rules out missing/non-file paths; an actual bad executable still
/// surfaces loudly as a spawn failure on connect.
#[tauri::command]
async fn verify_codex_path_native(path: String) -> Result<bool, String> {
    if path.trim().is_empty() || path.contains('\u{0}') {
        return Ok(false);
    }
    Ok(tokio::fs::metadata(&path)
        .await
        .map(|m| m.is_file())
        .unwrap_or(false))
}

/// Milliseconds since the last keyboard or mouse input *anywhere on the
/// desktop*, not just in this app's window (`GetLastInputInfo`, which reports
/// the session-wide last input tick).
///
/// Used to decide whether a finished turn is worth flashing the window for:
/// if the user has been touching the machine, they can see the transcript
/// update on their own. Reads a counter the OS already maintains -- nothing is
/// hooked, and no keystroke or cursor position is ever observed.
#[tauri::command]
fn system_idle_millis() -> Result<u64, String> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::System::SystemInformation::GetTickCount;
        use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetLastInputInfo, LASTINPUTINFO};

        let mut info = LASTINPUTINFO {
            cbSize: std::mem::size_of::<LASTINPUTINFO>() as u32,
            dwTime: 0,
        };
        // SAFETY: `info` is a correctly sized, fully initialized LASTINPUTINFO
        // and the call only writes to it.
        let ok = unsafe { GetLastInputInfo(&mut info) };
        if ok == 0 {
            return Err("GetLastInputInfo failed".into());
        }
        // Both counters wrap at ~49.7 days; wrapping_sub keeps the difference
        // correct across the rollover.
        let now = unsafe { GetTickCount() };
        Ok(u64::from(now.wrapping_sub(info.dwTime)))
    }
    #[cfg(not(windows))]
    {
        // Non-Windows builds have no equivalent here; reporting "just used"
        // means the notice simply never fires rather than firing wrongly.
        Ok(0)
    }
}

/// Open an interactive Windows shell at `path` in its own console window
/// (native-mode counterpart to `open_wsl_terminal`). Sets the child's cwd
/// directly rather than building a `cd`-then-path shell command, so `path`
/// never passes through cmd.exe's argument/quoting rules.
#[tauri::command]
fn open_native_terminal(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("terminal path must not be empty".into());
    }
    let mut command = std::process::Command::new("cmd.exe");
    command.current_dir(&path);
    #[cfg(windows)]
    command.creation_flags(0x0000_0010); // CREATE_NEW_CONSOLE
    command
        .spawn()
        .map_err(|e| format!("failed to open terminal: {e}"))?;
    Ok(())
}

/// Open `path` (an ordinary Windows path) in Explorer (native-mode
/// counterpart to `open_in_explorer`; no WSL UNC conversion needed).
#[tauri::command]
fn open_in_explorer_native(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Explorer path must not be empty".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(&path)
        .spawn()
        .map_err(|e| format!("failed to open Explorer: {e}"))?;
    Ok(())
}

/// Open Explorer with `path` selected within its containing folder
/// (native-mode counterpart to `reveal_in_explorer`).
#[tauri::command]
fn reveal_in_explorer_native(path: String) -> Result<(), String> {
    if path.trim().is_empty() {
        return Err("Explorer path must not be empty".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(format!("/select,{path}"))
        .spawn()
        .map_err(|e| format!("failed to open Explorer: {e}"))?;
    Ok(())
}

#[derive(serde::Serialize)]
struct OllamaModelInfo {
    name: String,
    context_length: Option<u64>,
}

const OLLAMA_WINDOWS_ROOT: &str = "http://127.0.0.1:11434";

/// Turn a failed `curl.exe` run into something the user can act on.
///
/// The old message was `curl.exe exited with exit code: 7`, which names
/// neither the address that was tried nor what code 7 means. That is the
/// worst case for the failure people actually hit -- Ollama *is* installed
/// and running, just not where this looked (a different port, or bound to an
/// address other than loopback). Without the URL in the message there is
/// nothing to compare against, so the report becomes "it says Ollama isn't
/// running, but it is".
///
/// Codes are curl's documented exit statuses; anything unrecognised falls
/// through to the raw code plus whatever curl wrote to stderr, which is still
/// strictly more than before because the URL is now attached.
fn ollama_curl_error(url: &str, code: Option<i32>, stderr: &str) -> String {
    let detail = stderr.trim();
    let explanation = match code {
        Some(6) => Some("接続先のホスト名を解決できませんでした。"),
        Some(7) => Some(
            "接続を拒否されました。Ollamaが起動していないか、別のアドレス・ポートで待ち受けています。",
        ),
        Some(28) => Some("接続がタイムアウトしました。"),
        Some(52) => Some("接続はできましたが、応答が空でした。"),
        _ => None,
    };
    match explanation {
        Some(explanation) => format!(
            "{url} へ接続できませんでした: {explanation}\n\
             `curl {url}` をPowerShellで実行すると同じ結果を再現できます。\
             別のポートで動かしている場合は、そちらのアドレスを確認してください。"
        ),
        None => {
            let code = code
                .map(|c| c.to_string())
                .unwrap_or_else(|| "不明".to_string());
            if detail.is_empty() {
                format!("{url} への問い合わせに失敗しました（curl 終了コード {code}）。")
            } else {
                format!("{url} への問い合わせに失敗しました（curl 終了コード {code}）: {detail}")
            }
        }
    }
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
    // Every failure below names the URL that was tried. "Ollama is installed
    // and running, but this says it isn't" is only diagnosable if the message
    // says where it looked.
    let url = format!("{OLLAMA_WINDOWS_ROOT}/api/tags");
    let output = tokio::process::Command::new("curl.exe")
        .args(["-sS", &url])
        .output()
        .await
        .map_err(|e| format!("curl.exe を実行できませんでした（{url} への問い合わせ）: {e}"))?;
    if !output.status.success() {
        return Err(ollama_curl_error(
            &url,
            output.status.code(),
            &String::from_utf8_lossy(&output.stderr),
        ));
    }
    let body = String::from_utf8_lossy(&output.stdout);
    let json: Value = serde_json::from_str(&body).map_err(|e| {
        format!(
            "{url} からの応答をJSONとして解釈できませんでした: {e}\n\
             そのアドレスでOllama以外のサービスが待ち受けている可能性があります。"
        )
    })?;
    let models = json.get("models").and_then(|v| v.as_array()).ok_or_else(|| {
        format!(
            "{url} は応答しましたが、Ollamaのモデル一覧の形式ではありませんでした（`models` が見つかりません）。\n\
             そのアドレスで別のサービスが待ち受けているか、Ollamaのバージョンが想定と異なる可能性があります。"
        )
    })?;
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

/// Choose the endpoint from the app-server's point of view. Native Codex runs
/// on Windows and therefore uses Windows loopback. WSL Codex first tries
/// loopback (mirrored networking) and only falls back to the WSL default
/// gateway (NAT networking). OLLAMA_HOST is intentionally ignored: it is the
/// Ollama server's bind address, not a client destination.
async fn resolve_ollama_codex_base_url(
    connection_mode: &str,
    distro: &str,
) -> Result<String, String> {
    if connection_mode == "native" {
        return Ok(format!("{OLLAMA_WINDOWS_ROOT}/v1"));
    }

    validate_distro(distro)?;
    let loopback_error = match probe_ollama_from_wsl(distro, OLLAMA_WINDOWS_ROOT).await {
        Ok(()) => return Ok(format!("{OLLAMA_WINDOWS_ROOT}/v1")),
        Err(error) => error,
    };

    let gateway = wsl_default_gateway(distro).await?;
    let gateway_root = ollama_root_for_host(&gateway);
    probe_ollama_from_wsl(distro, &gateway_root)
        .await
        .map_err(|gateway_error| {
            format!(
                "Ollama is unreachable from WSL via loopback ({loopback_error}) or NAT gateway {gateway} ({gateway_error})"
            )
        })?;
    Ok(format!("{gateway_root}/v1"))
}

async fn probe_ollama_from_wsl(distro: &str, root: &str) -> Result<(), String> {
    let url = format!("{}/api/version", root.trim_end_matches('/'));
    let output = tokio::process::Command::new("wsl.exe")
        .args([
            "-d",
            distro,
            "--exec",
            "curl",
            "-fsS",
            "--connect-timeout",
            "3",
            "--max-time",
            "5",
            "-o",
            "/dev/null",
            &url,
        ])
        .output()
        .await
        .map_err(|e| format!("failed to run WSL curl: {e}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        if detail.is_empty() {
            Err(format!("WSL curl exited with {}", output.status))
        } else {
            Err(detail)
        }
    }
}

async fn wsl_default_gateway(distro: &str) -> Result<String, String> {
    let output = tokio::process::Command::new("wsl.exe")
        .args(["-d", distro, "--exec", "ip", "route", "show", "default"])
        .output()
        .await
        .map_err(|e| format!("failed to read the WSL default route: {e}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(if detail.is_empty() {
            format!("WSL ip route exited with {}", output.status)
        } else {
            detail
        });
    }
    parse_default_gateway(&String::from_utf8_lossy(&output.stdout))
        .ok_or_else(|| "WSL default route did not contain a valid gateway".to_string())
}

fn parse_default_gateway(routes: &str) -> Option<String> {
    routes.lines().find_map(|line| {
        let fields: Vec<&str> = line.split_whitespace().collect();
        let via = fields.iter().position(|field| *field == "via")?;
        let candidate = *fields.get(via + 1)?;
        candidate
            .parse::<std::net::IpAddr>()
            .ok()
            .map(|address| address.to_string())
    })
}

fn ollama_root_for_host(host: &str) -> String {
    if host.contains(':') {
        format!("http://[{host}]:11434")
    } else {
        format!("http://{host}:11434")
    }
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
    // Multiple windows/processes are intentionally allowed. codex app-server
    // already refuses a second thread/resume on a thread another process has
    // open (-32600 "already has an active writer") instead of corrupting
    // anything, and two processes sharing this app's WebView2 profile folder
    // were confirmed live (two-instance test, 2026-08-22) not to conflict.
    // The remaining shared-profile risk -- localStorage settings clobbering
    // each other -- is handled in the frontend by only cross-window-syncing
    // append-only sets (projectPaths, acknowledgedCodexVersions), never a
    // window's own active choice (connectionMode, provider, distro, ...).
    tauri::Builder::default()
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
            open_native_terminal,
            open_in_explorer_native,
            reveal_in_explorer_native,
            save_pasted_image,
            delete_pasted_image,
            windows_path_to_wsl,
            list_ollama_models,
            list_wsl_distros,
            detect_codex_path,
            verify_codex_path,
            detect_codex_path_native,
            verify_codex_path_native,
            system_idle_millis
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::{
        ollama_curl_error, ollama_root_for_host, parse_default_gateway, pasted_image_filename,
        pasted_image_filename_native, strip_wsl_unc, validate_distro, wsl_exec_args,
    };

    const URL: &str = "http://127.0.0.1:11434/api/tags";

    // The whole point of the message: someone whose Ollama *is* running has to
    // be able to see that this looked somewhere else.
    #[test]
    fn every_curl_failure_names_the_address_that_was_tried() {
        for code in [Some(6), Some(7), Some(28), Some(52), Some(99), None] {
            let message = ollama_curl_error(URL, code, "");
            assert!(
                message.contains(URL),
                "code {code:?} produced a message without the URL: {message}"
            );
        }
    }

    #[test]
    fn connection_refused_says_so_instead_of_exit_code_7() {
        let message = ollama_curl_error(URL, Some(7), "curl: (7) Failed to connect");
        assert!(message.contains("接続を拒否"));
        // Names the two things worth checking, since "is it running?" alone is
        // useless to someone who already started it.
        assert!(message.contains("起動していない"));
        assert!(message.contains("ポート"));
        assert!(!message.contains("exit code"));
    }

    #[test]
    fn unknown_codes_keep_the_raw_code_and_stderr() {
        let message = ollama_curl_error(URL, Some(99), "curl: (99) something new");
        assert!(message.contains("99"));
        assert!(message.contains("something new"));
    }

    #[test]
    fn a_missing_exit_code_is_reported_rather_than_dropped() {
        // Killed by a signal: status.code() is None.
        let message = ollama_curl_error(URL, None, "");
        assert!(message.contains("不明"));
        assert!(message.contains(URL));
    }

    #[test]
    fn empty_stderr_does_not_leave_a_dangling_colon() {
        let message = ollama_curl_error(URL, Some(99), "   ");
        assert!(message.trim_end().ends_with('。'), "got: {message}");
    }

    #[test]
    fn parses_wsl_nat_gateway_from_default_route() {
        assert_eq!(
            parse_default_gateway("default via 172.21.112.1 dev eth0 proto kernel\n"),
            Some("172.21.112.1".to_string())
        );
        assert_eq!(parse_default_gateway("default dev eth0 scope link\n"), None);
    }

    #[test]
    fn builds_ollama_root_for_ipv4_and_ipv6_gateways() {
        assert_eq!(
            ollama_root_for_host("172.21.112.1"),
            "http://172.21.112.1:11434"
        );
        assert_eq!(ollama_root_for_host("fd00::1"), "http://[fd00::1]:11434");
    }

    #[test]
    fn wsl_commands_use_exec_argument_boundary() {
        let command_args = ["sh", "-c", "echo $HOME"];
        assert_eq!(
            wsl_exec_args("Ubuntu-24.04", &command_args),
            ["-d", "Ubuntu-24.04", "--exec", "sh", "-c", "echo $HOME"]
        );
    }

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
    fn pasted_image_delete_scope_is_narrow_native() {
        let valid = std::env::temp_dir()
            .join("wslcodexgui-paste-550e8400-e29b-41d4-a716-446655440000.png")
            .to_string_lossy()
            .into_owned();
        assert_eq!(
            pasted_image_filename_native(&valid).unwrap(),
            "wslcodexgui-paste-550e8400-e29b-41d4-a716-446655440000.png"
        );
        let unrelated = std::env::temp_dir()
            .join("unrelated.png")
            .to_string_lossy()
            .into_owned();
        assert!(pasted_image_filename_native(&unrelated).is_err());
        assert!(
            pasted_image_filename_native(r"C:\Users\someone\wslcodexgui-paste-1234.png").is_err()
        );
        let bad_uuid = std::env::temp_dir()
            .join("wslcodexgui-paste-not-a-uuid.png")
            .to_string_lossy()
            .into_owned();
        assert!(pasted_image_filename_native(&bad_uuid).is_err());
    }

    #[test]
    fn invalid_distro_components_are_rejected() {
        assert!(validate_distro("Ubuntu-24.04").is_ok());
        assert!(validate_distro("").is_err());
        assert!(validate_distro("Ubuntu\\other").is_err());
        assert!(validate_distro("Ubuntu&cmd").is_ok());
    }
}
