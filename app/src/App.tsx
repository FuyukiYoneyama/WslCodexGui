import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  ApprovalDecision,
  CommandApprovalParams,
  ConnectionTaggedEvent,
  GetAccountRateLimitsResponse,
  InitializeResponse,
  Model,
  Notification,
  RequestId,
  ServerRequest,
  Thread,
  ThreadItem,
  ThreadTokenUsage,
  ThreadTokenUsageUpdated,
  TurnCompletedNotification,
} from "./types";
import {
  AgentMessageDeltaSchema,
  GetAccountRateLimitsResponseSchema,
  GitDiffToRemoteResponseSchema,
  InitializeResponseSchema,
  ItemNotificationSchema,
  ModelListResponseSchema,
  ServerRequestSchema,
  ThreadListResponseSchema,
  ThreadReadResponseSchema,
  ThreadResumeResponseSchema,
  ThreadStartResponseSchema,
  ThreadTokenUsageUpdatedSchema,
  TurnCompletedNotificationSchema,
  TurnStartedNotificationSchema,
  parseOrReport,
} from "./schemas";
import {
  journalAbort,
  journalGet,
  journalMarkCompleted,
  journalMarkSent,
  journalMarkStarted,
  journalPrepare,
} from "./journal";
import { latestInProgressTurnId, sameImageContext, type ImageContext } from "./stateLogic";
import { shouldAbortJournal } from "./rpcFailurePolicy";
import { CONFIRMED_CODEX_CLI_VERSIONS, isConfirmedCodexCliVersion, parseCodexCliVersion } from "./codexVersion";
import { decideJournalReconciliation } from "./journalReconciliation";
import { isApprovalMethod } from "./approvalMethods";
import "./App.css";

type ConnState = "disconnected" | "connecting" | "connected" | "disconnecting";

// Result of the codex-path check for the currently selected distro. The
// connect button is enabled only in the "ok" state (spec: codexが確認
// できないときは接続不可).
type CodexPathStatus = "checking" | "ok" | "ng";

interface WslDistroInfo {
  name: string;
  is_default: boolean;
}

// ENV-01 (spec 4.3): last confirmed-working values on this machine. Used as
// the initial default only — still overridable and persisted per N-20/F-02a.
const DEFAULT_CODEX_PATH = "/home/user/.nvm/versions/node/v22.22.2/bin/codex";
const DEFAULT_PROJECT_PATH = "/home/user";

// thread/start's approvalPolicy, fixed for the lifetime of a thread (cannot
// be changed on thread/resume). "granular" also exists server-side but is
// undocumented in `codex --help` and not exposed here.
type ApprovalPolicy = "untrusted" | "on-request" | "never";
const APPROVAL_POLICIES: { value: ApprovalPolicy; label: string }[] = [
  { value: "untrusted", label: "信頼済みコマンドのみ自動実行（それ以外は確認）" },
  { value: "on-request", label: "モデルが必要と判断した時だけ確認（既定）" },
  { value: "never", label: "確認なし（実行失敗はそのままモデルに返る）" },
];

function loadStringList(key: string, fallback: string[]): string[] {
  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as string[]) : [];
    if (Array.isArray(parsed) && parsed.length > 0) return parsed;
  } catch {
    // ignore malformed storage
  }
  return fallback;
}

interface DisplayItem {
  key: string;
  item: ThreadItem;
  streamingText?: string;
}

interface PastedImage extends ImageContext {
  id: string;
  wslPath: string;
  previewUrl: string;
}

// `connect`/`rpc_request` reject with a structured RpcFailure object;
// every other command still rejects with a plain string. This normalizes
// both into a display string without ever showing "[object Object]".
function rpcErrorText(e: unknown): string {
  if (e && typeof e === "object" && "message" in e && typeof (e as { message: unknown }).message === "string") {
    return (e as { message: string }).message;
  }
  return String(e);
}

function rpcErrorKind(e: unknown): string | undefined {
  if (e && typeof e === "object" && "kind" in e) {
    return (e as { kind?: unknown }).kind as string | undefined;
  }
  return undefined;
}

function decisionLabel(d: ApprovalDecision): string {
  if (typeof d === "string") {
    switch (d) {
      case "accept": return "許可する";
      case "acceptForSession": return "セッション中許可";
      case "decline": return "今回だけ拒否";
      case "cancel": return "中止";
      default: return d;
    }
  }
  const key = Object.keys(d)[0] ?? "?";
  switch (key) {
    case "acceptWithExecpolicyAmendment": return "ポリシーを緩めて許可";
    case "applyNetworkPolicyAmendment": return "ネットワーク許可を適用";
    default: return key;
  }
}

export default function App() {
  const [distro, setDistro] = useState(() => localStorage.getItem("distro") ?? "Ubuntu-24.04");
  const [distros, setDistros] = useState<WslDistroInfo[]>([]);
  const [codexPath, setCodexPath] = useState(
    () => localStorage.getItem("codexPath") ?? DEFAULT_CODEX_PATH
  );
  const [codexStatus, setCodexStatus] = useState<CodexPathStatus>("checking");
  const [codexNotice, setCodexNotice] = useState<string | null>(null);
  // Provider override, applied only as a -c flag on the spawned app-server
  // process (never written to ~/.codex/config.toml) so the default provider
  // used by every other codex client on this machine is never touched.
  const [provider, setProvider] = useState<"openai" | "ollama">(
    () => (localStorage.getItem("provider") as "openai" | "ollama" | null) ?? "openai"
  );
  const [ollamaModel, setOllamaModel] = useState(
    () => localStorage.getItem("ollamaModel") ?? "gpt-oss:20b"
  );
  // codex has no built-in metadata for arbitrary Ollama models and otherwise
  // falls back to an oversized default (see the "Defaulting to fallback
  // metadata" warning) that doesn't match what Ollama's num_ctx actually
  // serves — align the two explicitly instead.
  const [ollamaContextWindow, setOllamaContextWindow] = useState(
    () => localStorage.getItem("ollamaContextWindow") ?? "32768"
  );
  const [ollamaModels, setOllamaModels] = useState<{ name: string; contextLength: number | null }[]>([]);
  const [ollamaModelsLoading, setOllamaModelsLoading] = useState(false);
  // F-02a: history of folders the user has explicitly chosen via the native
  // Explorer picker (browseForProject) or that a resumed thread's own cwd
  // pointed at — never an automatic filesystem scan.
  const [projectPaths, setProjectPaths] = useState<string[]>(() =>
    loadStringList("projectPaths", [DEFAULT_PROJECT_PATH])
  );
  const [projectCwd, setProjectCwd] = useState(
    () => localStorage.getItem("projectCwd") ?? loadStringList("projectPaths", [DEFAULT_PROJECT_PATH])[0]
  );
  // Applies to threads created from now on (thread/resume keeps whatever
  // policy the thread already had — this can't change after the fact).
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(() => {
    const stored = localStorage.getItem("approvalPolicy");
    return APPROVAL_POLICIES.some((p) => p.value === stored) ? (stored as ApprovalPolicy) : "on-request";
  });
  const onApprovalPolicyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value as ApprovalPolicy;
    setApprovalPolicy(value);
    localStorage.setItem("approvalPolicy", value);
  };

  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [initInfo, setInitInfo] = useState<InitializeResponse | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  // F-09a: cursor from the most recent page fetched (null once thread/list
  // has said there's nothing more). Reset to unknown ("has more" assumed)
  // whenever the visible list is rebuilt from scratch by refreshThreads.
  const [threadsNextCursor, setThreadsNextCursor] = useState<string | null | undefined>(undefined);
  const [threadsLoadingMore, setThreadsLoadingMore] = useState(false);
  const [appVersion, setAppVersion] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const { getVersion } = await import("@tauri-apps/api/app");
        setAppVersion(await getVersion());
      } catch {
        // dev server without the Tauri runtime, etc.; footer just omits it
      }
    })();
  }, []);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [approvals, setApprovals] = useState<ServerRequest[]>([]);
  const [approvalRespondingId, setApprovalRespondingId] = useState<RequestId | null>(null);
  const [input, setInput] = useState("");
  // Images pasted from the clipboard, staged until send() attaches them to
  // the turn as UserInput's localImage (app-server reads them from a WSL
  // temp path — see save_pasted_image in lib.rs). previewUrl is a browser
  // object URL for the thumbnail only; wslPath is what actually gets sent.
  const [pastedImages, setPastedImages] = useState<PastedImage[]>([]);
  const [imageSavesPending, setImageSavesPending] = useState(0);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [stderrLog, setStderrLog] = useState<string[]>([]);

  // "/" command palette (composer autocomplete).
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [modelPicker, setModelPicker] = useState<Model[] | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [modelOverrideLabel, setModelOverrideLabel] = useState<string | null>(null);
  const [defaultModelLabel, setDefaultModelLabel] = useState<string | null>(null);
  const [threadTokenUsage, setThreadTokenUsage] = useState<ThreadTokenUsage | null>(null);
  const [usagePanel, setUsagePanel] = useState<GetAccountRateLimitsResponse | null>(null);
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [diffPanel, setDiffPanel] = useState<{ sha: string; diff: string } | null>(null);
  const [statusPanel, setStatusPanel] = useState<Thread | null>(null);

  // Refs mirroring state that event handlers need without re-subscribing.
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  const distroRef = useRef(distro);
  distroRef.current = distro;
  const pastedImagesRef = useRef<PastedImage[]>([]);
  pastedImagesRef.current = pastedImages;
  const pasteGenerationRef = useRef(0);
  const imagesAwaitingTurnRef = useRef<PastedImage[]>([]);
  const turnImagesRef = useRef<Map<string, PastedImage[]>>(new Map());

  // Tags the Connection currently considered "live". Every Rust-emitted
  // event carries connectionId; events from a Connection we've already
  // replaced (e.g. its delayed "disconnected" arriving after a new
  // connect() already succeeded) are ignored instead of corrupting state.
  const connectionIdRef = useRef<string | null>(null);

  const deletePastedImageFile = useCallback((image: Pick<PastedImage, "distro" | "wslPath">) => {
    void invoke("delete_pasted_image", { distro: image.distro, path: image.wslPath }).catch((error) => {
      setErrorBanner(`一時画像の削除に失敗しました: ${error}`);
    });
  }, []);

  const discardPastedImages = useCallback(() => {
    pasteGenerationRef.current += 1;
    const images = pastedImagesRef.current;
    pastedImagesRef.current = [];
    setPastedImages([]);
    for (const image of images) {
      URL.revokeObjectURL(image.previewUrl);
      deletePastedImageFile(image);
    }
  }, [deletePastedImageFile]);

  const discardSentImages = useCallback(() => {
    const images = [
      ...imagesAwaitingTurnRef.current,
      ...Array.from(turnImagesRef.current.values()).flat(),
    ];
    imagesAwaitingTurnRef.current = [];
    turnImagesRef.current.clear();
    for (const image of images) deletePastedImageFile(image);
  }, [deletePastedImageFile]);

  useEffect(() => () => {
    pasteGenerationRef.current += 1;
    for (const image of pastedImagesRef.current) {
      URL.revokeObjectURL(image.previewUrl);
      deletePastedImageFile(image);
    }
    pastedImagesRef.current = [];
    discardSentImages();
  }, [deletePastedImageFile, discardSentImages]);

  // Delta batching (N-18): accumulate per-item text, flush on a ~33ms tick.
  const deltaBufRef = useRef<Map<string, string>>(new Map());
  const flushScheduledRef = useRef(false);
  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    setTimeout(() => {
      flushScheduledRef.current = false;
      const buf = deltaBufRef.current;
      if (buf.size === 0) return;
      const entries = new Map(buf);
      buf.clear();
      setItems((prev) =>
        prev.map((di) => {
          const add = entries.get(di.item.id);
          if (add === undefined) return di;
          return { ...di, streamingText: (di.streamingText ?? "") + add };
        })
      );
    }, 33);
  }, []);

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, activeTurnId]);

  // The composer is disabled while a turn runs (N-17), which blurs it — the
  // browser doesn't restore focus on its own once it re-enables, so do it
  // explicitly whenever a turn finishes.
  const composerInputRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (connState === "connected" && activeThreadId && !activeTurnId) {
      composerInputRef.current?.focus();
    }
  }, [activeTurnId, connState, activeThreadId]);

  // KEEP THIS. It looks like dead/pointless code in isolation (focus a
  // hidden input, then immediately blur it) — that's exactly the shape of
  // thing a cleanup pass would delete. It is a deliberate workaround for a
  // real WebView2 bug (see README.md, "起動直後だけIMEのON/OFFがおかしい"):
  // IME ON/OFF toggling misbehaves on the very first element focused after the window
  // is created, and only self-corrects once focus leaves and returns.
  // Confirmed present, and confirmed fixed by this warm-up, on this machine
  // (2026-07-19). Do not remove without first re-testing IME behavior on a
  // freshly launched build — the bug is intermittent (it also affects the
  // official Windows Codex app on and off), so its absence in one test run
  // is not proof it's gone.
  useEffect(() => {
    const t = setTimeout(() => {
      const dummy = document.createElement("input");
      dummy.style.position = "fixed";
      dummy.style.left = "-9999px";
      dummy.style.opacity = "0";
      dummy.tabIndex = -1;
      document.body.appendChild(dummy);
      dummy.focus();
      dummy.blur();
      document.body.removeChild(dummy);
    }, 200);
    return () => clearTimeout(t);
  }, []);

  // Drag-and-drop from Explorer: convert dropped Windows paths to WSL paths
  // (windows_path_to_wsl) and insert them into the composer. Tauri's OS-level
  // drag-drop only reports a cursor position, not the DOM target, so we test
  // that position against the composer's own bounding box.
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    // event.position is in physical pixels; getBoundingClientRect() is in
    // logical/CSS pixels, so they only line up 1:1 without DPI scaling.
    let scaleFactor = 1;

    const isOverComposer = (x: number, y: number) => {
      const el = composerWrapRef.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const lx = x / scaleFactor;
      const ly = y / scaleFactor;
      return lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom;
    };

    (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      scaleFactor = await getCurrentWindow().scaleFactor();
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const un = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragOver(isOverComposer(p.position.x, p.position.y));
          return;
        }
        if (p.type === "leave") {
          setDragOver(false);
          return;
        }
        if (p.type === "drop") {
          setDragOver(false);
          // Composer is the only drop target this app has, so accept a drop
          // anywhere in the window rather than gating on position — the
          // "enter"/"over" position tracking above is cosmetic (highlight)
          // only and occasionally disagreed with the drop event's own
          // position, silently swallowing otherwise-valid drops.
          void (async () => {
            const wslPaths: string[] = [];
            for (const winPath of p.paths) {
              try {
                wslPaths.push(await invoke<string>("windows_path_to_wsl", { path: winPath, distro }));
              } catch (e) {
                setErrorBanner(`パス変換に失敗しました（${winPath}）: ${e}`);
              }
            }
            if (wslPaths.length === 0) return;
            setInput((prev) => (prev ? `${prev} ${wslPaths.join(" ")}` : wslPaths.join(" ")));
          })();
        }
      });
      if (cancelled) un();
      else unlisten = un;
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [distro]);

  const [showArchived, setShowArchived] = useState(false);

  // --- codex path resolution (per-distro) ---
  // Monotonic generation counter: any newer check (distro switch, manual
  // path edit) invalidates the in-flight result of an older one, so a slow
  // wsl.exe probe can never overwrite the state of a later check.
  const codexCheckGenRef = useRef(0);
  const verifyTimerRef = useRef<number | undefined>(undefined);

  // Resolve the codex path for `d`: verify `candidate` first if given (a
  // previously saved/typed path), otherwise (or if it no longer exists)
  // auto-detect inside the distro. Only an "ok" outcome enables connect.
  const resolveCodexPath = useCallback(async (d: string, candidate: string | null) => {
    const gen = ++codexCheckGenRef.current;
    window.clearTimeout(verifyTimerRef.current);
    setCodexStatus("checking");
    setCodexNotice(null);
    try {
      if (candidate?.trim()) {
        const ok = await invoke<boolean>("verify_codex_path", { distro: d, path: candidate.trim() });
        if (gen !== codexCheckGenRef.current) return;
        if (ok) {
          setCodexPath(candidate.trim());
          setCodexStatus("ok");
          return;
        }
      }
      const found = await invoke<string | null>("detect_codex_path", { distro: d });
      if (gen !== codexCheckGenRef.current) return;
      if (found) {
        setCodexPath(found);
        setCodexStatus("ok");
      } else {
        setCodexPath("");
        setCodexStatus("ng");
        setCodexNotice(
          `${d} 内で codex が見つかりませんでした。WSLターミナルで \`which codex\` を実行し、表示された絶対パスを手入力してください。`
        );
      }
    } catch (e) {
      if (gen !== codexCheckGenRef.current) return;
      setCodexStatus("ng");
      setCodexNotice(`codexパスの確認に失敗しました: ${e}`);
    }
  }, []);

  // Startup: enumerate installed WSL distros, preselect the stored one if it
  // still exists (else the WSL default), then resolve its codex path.
  useEffect(() => {
    void (async () => {
      const storedDistro = localStorage.getItem("distro");
      const storedPath = localStorage.getItem("codexPath") ?? DEFAULT_CODEX_PATH;
      try {
        const list = await invoke<WslDistroInfo[]>("list_wsl_distros");
        setDistros(list);
        const chosen =
          list.find((d) => d.name === storedDistro)?.name ??
          list.find((d) => d.is_default)?.name ??
          list[0].name;
        setDistro(chosen);
        // The saved codex path only makes sense for the distro it was saved
        // with; for any other distro start from auto-detection.
        const candidate = storedDistro === null || storedDistro === chosen ? storedPath : null;
        void resolveCodexPath(chosen, candidate);
      } catch (e) {
        // wsl.exe unavailable or no distros: keep the free-text fallback
        // input and still try to validate whatever path is stored.
        setErrorBanner(`WSLディストリ一覧の取得に失敗しました: ${e}`);
        void resolveCodexPath(storedDistro ?? "Ubuntu-24.04", storedPath);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDistroChange = (name: string) => {
    setDistro(name);
    localStorage.setItem("distro", name);
    void resolveCodexPath(name, null);
  };

  // Manual codex-path entry: debounce, then verify the file actually exists
  // (and is executable) inside the selected distro before enabling connect.
  const onCodexPathInput = (value: string) => {
    setCodexPath(value);
    const gen = ++codexCheckGenRef.current;
    window.clearTimeout(verifyTimerRef.current);
    setCodexNotice(null);
    if (!value.trim()) {
      setCodexStatus("ng");
      setCodexNotice("codexの絶対パスを入力してください。");
      return;
    }
    setCodexStatus("checking");
    verifyTimerRef.current = window.setTimeout(() => {
      void (async () => {
        try {
          const ok = await invoke<boolean>("verify_codex_path", {
            distro: distroRef.current,
            path: value.trim(),
          });
          if (gen !== codexCheckGenRef.current) return;
          setCodexStatus(ok ? "ok" : "ng");
          setCodexNotice(ok ? null : "指定されたパスに実行可能な codex が見つかりません。");
        } catch (e) {
          if (gen !== codexCheckGenRef.current) return;
          setCodexStatus("ng");
          setCodexNotice(`codexパスの確認に失敗しました: ${e}`);
        }
      })();
    }, 500);
  };

  // Full reset: replaces the visible list with page 1 and re-arms the
  // cursor. Used on connect, archived-view toggle, and the manual ↻ button.
  const refreshThreads = useCallback(async () => {
    try {
      const raw = await invoke("rpc_request", {
        method: "thread/list",
        params: { limit: 30, archived: showArchived },
      });
      const res = parseOrReport(ThreadListResponseSchema, raw, "thread/list", setErrorBanner);
      if (!res) return;
      setThreads(res.data as unknown as Thread[]);
      setThreadsNextCursor(res.nextCursor ?? null);
    } catch (e) {
      setErrorBanner(`thread/list failed: ${rpcErrorText(e)}`);
    }
  }, [showArchived]);

  // F-09a: fetch the next page and append. Dedupes by id in case a thread
  // was created/moved between page fetches and ends up straddling pages.
  const loadMoreThreads = useCallback(async () => {
    if (!threadsNextCursor || threadsLoadingMore) return;
    setThreadsLoadingMore(true);
    try {
      const raw = await invoke("rpc_request", {
        method: "thread/list",
        params: { limit: 30, archived: showArchived, cursor: threadsNextCursor },
      });
      const res = parseOrReport(ThreadListResponseSchema, raw, "thread/list", setErrorBanner);
      if (!res) return;
      const page = res.data as unknown as Thread[];
      setThreads((prev) => {
        const seen = new Set(prev.map((t) => t.id));
        return [...prev, ...page.filter((t) => !seen.has(t.id))];
      });
      setThreadsNextCursor(res.nextCursor ?? null);
    } catch (e) {
      setErrorBanner(`thread/list (続き) failed: ${rpcErrorText(e)}`);
    } finally {
      setThreadsLoadingMore(false);
    }
  }, [showArchived, threadsNextCursor, threadsLoadingMore]);

  // refreshThreads is recreated when showArchived changes; re-fetch so
  // toggling the archived view doesn't wait for the next unrelated refresh.
  useEffect(() => {
    if (connState === "connected") void refreshThreads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived]);

  // Silent refresh for the always-on footer badge (no error banner spam —
  // this runs automatically, not on explicit user action).
  const fetchUsage = useCallback(async () => {
    try {
      const raw = await invoke("rpc_request", {
        method: "account/rateLimits/read",
        params: undefined,
      });
      const parsed = GetAccountRateLimitsResponseSchema.safeParse(raw);
      if (parsed.success) setUsagePanel(parsed.data as unknown as GetAccountRateLimitsResponse);
      // else: silently keep the stale badge, same as any other failure here.
    } catch {
      // connection may be mid-teardown etc.; footer badge just stays stale
    }
  }, []);

  // --- event wiring ---
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];
    const isCurrent = (connectionId: string | undefined) =>
      !!connectionId && connectionId === connectionIdRef.current;

    unlisteners.push(
      listen<Notification>("codex:notification", (ev) => {
        if (!isCurrent(ev.payload.connectionId)) return; // stale connection's event
        const { method, params } = ev.payload;
        const threadId = (params as { threadId?: string } | undefined)?.threadId;
        // Image cleanup is connection-wide, so process turn lifecycle even
        // when its thread is not the one currently displayed.
        const lifecycleTurnId = (params as { turn?: { id?: string } } | undefined)?.turn?.id;
        if (method === "turn/started" && lifecycleTurnId && imagesAwaitingTurnRef.current.length > 0) {
          turnImagesRef.current.set(lifecycleTurnId, imagesAwaitingTurnRef.current);
          imagesAwaitingTurnRef.current = [];
        } else if (method === "turn/completed" && lifecycleTurnId) {
          const completedImages = turnImagesRef.current.get(lifecycleTurnId) ?? [];
          turnImagesRef.current.delete(lifecycleTurnId);
          for (const image of completedImages) deletePastedImageFile(image);
        }
        if (threadId && threadId !== activeThreadIdRef.current) return;

        switch (method) {
          case "turn/started": {
            const p = parseOrReport(TurnStartedNotificationSchema, params, "turn/started", setErrorBanner);
            if (!p) break;
            setActiveTurnId(p.turn.id);
            journalMarkStarted(p.threadId, p.turn.id);
            break;
          }
          case "turn/completed": {
            const p = parseOrReport(TurnCompletedNotificationSchema, params, "turn/completed", setErrorBanner);
            if (!p) break;
            setActiveTurnId(null);
            if (p.turn.status === "failed") {
              setErrorBanner(`Turn failed: ${JSON.stringify((p.turn as unknown as TurnCompletedNotification["turn"]).error)}`);
            }
            journalMarkCompleted(p.threadId);
            void fetchUsage(); // keep the footer badge current after each turn
            break;
          }
          case "item/started": {
            const p = parseOrReport(ItemNotificationSchema, params, "item/started", setErrorBanner);
            if (!p) break;
            const item = p.item as unknown as ThreadItem;
            setItems((prev) => [...prev, { key: item.id, item, streamingText: "" }]);
            break;
          }
          case "item/completed": {
            const p = parseOrReport(ItemNotificationSchema, params, "item/completed", setErrorBanner);
            if (!p) break;
            const item = p.item as unknown as ThreadItem;
            setItems((prev) => {
              const idx = prev.findIndex((di) => di.item.id === item.id);
              const done: DisplayItem = { key: item.id, item };
              if (idx < 0) return [...prev, done];
              const next = [...prev];
              next[idx] = done;
              return next;
            });
            break;
          }
          case "item/agentMessage/delta": {
            const p = parseOrReport(AgentMessageDeltaSchema, params, "item/agentMessage/delta", setErrorBanner);
            if (!p) break;
            const cur = deltaBufRef.current.get(p.itemId) ?? "";
            deltaBufRef.current.set(p.itemId, cur + p.delta);
            scheduleFlush();
            break;
          }
          case "item/commandExecution/outputDelta": {
            const p = params as { itemId?: string; delta?: string };
            if (p.itemId && typeof p.delta === "string") {
              const cur = deltaBufRef.current.get(p.itemId) ?? "";
              deltaBufRef.current.set(p.itemId, cur + p.delta);
              scheduleFlush();
            }
            break;
          }
          case "thread/tokenUsage/updated": {
            const p = parseOrReport(
              ThreadTokenUsageUpdatedSchema,
              params,
              "thread/tokenUsage/updated",
              setErrorBanner
            ) as unknown as ThreadTokenUsageUpdated | null;
            if (!p) break;
            setThreadTokenUsage(p.tokenUsage);
            break;
          }
          case "error": {
            setErrorBanner(JSON.stringify(params));
            break;
          }
          default:
            break; // N-10: unknown notifications are ignored, never fatal.
        }
      })
    );

    unlisteners.push(
      listen<ServerRequest>("codex:server-request", (ev) => {
        if (!isCurrent(ev.payload.connectionId)) return;
        const req = parseOrReport(ServerRequestSchema, ev.payload, "server-request", setErrorBanner);
        if (!req) return;
        // Only route known approval-flavored requests into the approval
        // modal; anything else would render as a confusing/blank approval
        // card instead of being visibly unhandled.
        if (isApprovalMethod(req.method)) {
          setApprovals((prev) => [...prev, req as ServerRequest]);
        } else {
          setErrorBanner(`未対応のserver request: ${req.method}`);
          void invoke("reject_server_request", {
            id: req.id,
            code: -32601,
            message: `Unsupported server request method: ${req.method}`,
          }).catch((error) => {
            setErrorBanner(`未対応server requestへのエラー応答に失敗: ${error}`);
          });
        }
      })
    );

    unlisteners.push(
      listen<ConnectionTaggedEvent>("codex:stderr", (ev) => {
        if (!isCurrent(ev.payload.connectionId)) return;
        setStderrLog((prev) => [...prev.slice(-199), ev.payload.line ?? ""]);
      })
    );

    unlisteners.push(
      listen<ConnectionTaggedEvent>("codex:disconnected", (ev) => {
        if (!isCurrent(ev.payload.connectionId)) return; // an already-replaced connection tearing down
        connectionIdRef.current = null;
        setConnState("disconnected");
        setActiveTurnId(null);
        discardPastedImages();
        discardSentImages();
        // Pending approvals died with the connection (spec 7.3: 失効).
        setApprovals([]);
      })
    );

    unlisteners.push(
      listen<ConnectionTaggedEvent>("codex:contamination", (ev) => {
        if (!isCurrent(ev.payload.connectionId)) return;
        setErrorBanner(`プロトコル外のstdout出力を検出: ${(ev.payload.line ?? "").slice(0, 200)}`);
      })
    );

    return () => {
      for (const u of unlisteners) u.then((f) => f());
    };
  }, [scheduleFlush, fetchUsage, discardPastedImages, discardSentImages, deletePastedImageFile]);

  // --- actions ---
  const doConnect = async (): Promise<boolean> => {
    if (!codexPath.trim()) {
      setErrorBanner(
        "WSL内のcodex実行ファイルの絶対パスを入力してください。WSLターミナルで `which codex` を実行すると確認できます（例: /home/user/.nvm/versions/node/v22.22.2/bin/codex）。灰色の文字は入力例であり、値は未入力です。"
      );
      return false;
    }
    if (codexStatus !== "ok") {
      setErrorBanner(
        codexNotice ?? "codexの場所を確認できていないため接続できません。パスの確認完了をお待ちください。"
      );
      return false;
    }
    discardPastedImages();
    localStorage.setItem("distro", distro);
    localStorage.setItem("codexPath", codexPath);
    localStorage.setItem("provider", provider);
    localStorage.setItem("ollamaModel", ollamaModel);
    localStorage.setItem("ollamaContextWindow", ollamaContextWindow);
    const configOverrides: string[] =
      provider === "ollama"
        ? [
            "model_provider=ollama",
            ...(ollamaModel.trim() ? [`model=${ollamaModel.trim()}`] : []),
            ...(ollamaContextWindow.trim() ? [`model_context_window=${ollamaContextWindow.trim()}`] : []),
          ]
        : [];
    setConnState("connecting");
    setErrorBanner(null);
    try {
      const raw = await invoke("connect", { distro, codexPath, configOverrides });
      const info = parseOrReport(InitializeResponseSchema, raw, "initialize", setErrorBanner);
      if (!info) {
        setConnState("disconnected");
        return false;
      }
      connectionIdRef.current = info.connectionId ?? null;
      setInitInfo(info as InitializeResponse);
      setConnState("connected");
      const codexVersion = parseCodexCliVersion(info.userAgent);
      if (codexVersion && !isConfirmedCodexCliVersion(codexVersion)) {
        setErrorBanner(
          `接続したCodex CLIのバージョン（${codexVersion}）はこのGUIで動作確認済みではありません（確認済み: ${CONFIRMED_CODEX_CLI_VERSIONS.join(", ")}）。接続自体は継続しますが、想定外の挙動が起きる可能性があります。`
        );
      }
      await refreshThreads();
      // Rate limits / model catalog are OpenAI-account concepts that don't
      // apply to a local Ollama provider (and model/list is unusable there
      // anyway — see the "failed to refresh available models" errors).
      if (provider !== "ollama") {
        void fetchUsage();
        void fetchDefaultModel();
      }
      return true;
    } catch (e) {
      setConnState("disconnected");
      setErrorBanner(
        `接続失敗: ${rpcErrorText(e)}（codexパスを自動で再検出しています…見つかった場合は入力欄が更新されます）`
      );
      // The saved codex path may have gone stale since it was last verified
      // (e.g. nvm reinstalled codex at a new location) -- re-check it right
      // away instead of leaving the user to retry blindly against a path
      // that's already dead. resolveCodexPath re-verifies the current path
      // first and falls back to auto-detection within the distro, updating
      // codexStatus/codexNotice (and codexPath itself, if a new one is
      // found) so the connect button's enabled state reflects reality again.
      void resolveCodexPath(distro, codexPath);
      return false;
    }
  };

  const doDisconnect = async () => {
    setConnState("disconnecting");
    try {
      await invoke("disconnect");
    } catch (e) {
      setErrorBanner(`切断処理でエラー: ${e}`);
    } finally {
      connectionIdRef.current = null;
      setConnState("disconnected");
      setActiveThreadId(null);
      setActiveTurnId(null);
      setItems([]);
      setApprovals([]);
      discardPastedImages();
      discardSentImages();
      setUsagePanel(null);
      setUsageModalOpen(false);
      setDefaultModelLabel(null);
      // Keep modelOverride across a reconnect (the point of setting it is to
      // stick until the user changes it); only the default-model lookup and
      // usage data are connection-scoped and need to be cleared.
    }
  };

  // F-08c reconciliation: if a journal entry from a previous (possibly
  // crashed) session is still open for this thread, resolve it against the
  // thread's own last turn status instead of guessing. Never resends.
  // Decision logic lives in journalReconciliation.ts; this just dispatches
  // the resulting side effects.
  const reconcileJournal = (
    threadId: string,
    turns: Pick<Thread["turns"][number], "id" | "status">[],
  ) => {
    const entry = journalGet(threadId);
    if (!entry) return;
    const outcome = decideJournalReconciliation(threadId, entry, turns);
    if (outcome.clear) journalMarkCompleted(threadId);
    if (outcome.message) setErrorBanner(outcome.message);
  };

  const resumeThread = async (threadId: string) => {
    setErrorBanner(null);
    if (threadId !== activeThreadIdRef.current) discardPastedImages();
    try {
      // approvalPolicy only takes effect the first time this app-server
      // process loads this particular thread (confirmed by live probe) --
      // re-opening a thread already touched this session silently keeps
      // whatever policy it loaded with. A disconnect/reconnect starts a new
      // process and makes the override apply again on next resume.
      const raw = await invoke("rpc_request", {
        method: "thread/resume",
        params: { threadId, approvalPolicy },
      });
      const res = parseOrReport(ThreadResumeResponseSchema, raw, "thread/resume", setErrorBanner);
      if (!res) return;
      const thread = res.thread as unknown as Thread;
      setActiveThreadId(thread.id);
      setActiveTurnId(latestInProgressTurnId(thread.turns));
      setThreadTokenUsage(null); // stale until the next tokenUsage/updated for this thread
      setItems(
        thread.turns.flatMap((t) =>
          t.items.map((item) => ({ key: `${t.id}:${item.id}`, item }))
        )
      );
      reconcileJournal(thread.id, thread.turns);
      // Reflect this thread's own workspace in the project selector, adding
      // it to the list if it isn't a discovered/registered path yet.
      if (thread.cwd) {
        const cwd = thread.cwd;
        setProjectCwd(cwd);
        localStorage.setItem("projectCwd", cwd);
        setProjectPaths((prev) => {
          if (prev.includes(cwd)) return prev;
          const next = [...prev, cwd].sort();
          localStorage.setItem("projectPaths", JSON.stringify(next));
          return next;
        });
      }
    } catch (e) {
      setErrorBanner(`thread/resume failed: ${rpcErrorText(e)}`);
    }
  };

  // Thread list stays visible after disconnect (spec: it's read from a
  // Codex-side source of truth, 8.1節); clicking one while not connected
  // asks first instead of failing with "not connected".
  const openThread = async (threadId: string) => {
    if (connState !== "connected") {
      setPendingThreadId(threadId);
      return;
    }
    await resumeThread(threadId);
  };

  const startRenaming = (t: Thread) => {
    setRenamingThreadId(t.id);
    setRenameInput(t.name ?? t.preview ?? "");
  };

  const confirmRename = async () => {
    const threadId = renamingThreadId;
    const name = renameInput.trim();
    setRenamingThreadId(null);
    if (!threadId || !name) return;
    try {
      await invoke("rpc_request", {
        method: "thread/name/set",
        params: { threadId, name },
      });
      setThreads((prev) => prev.map((t) => (t.id === threadId ? { ...t, name } : t)));
    } catch (e) {
      setErrorBanner(`thread/name/set failed: ${rpcErrorText(e)}`);
    }
  };

  const archiveThread = async (t: Thread) => {
    try {
      await invoke("rpc_request", { method: "thread/archive", params: { threadId: t.id } });
      setThreads((prev) => prev.filter((th) => th.id !== t.id));
      if (activeThreadId === t.id) {
        discardPastedImages();
        setActiveThreadId(null);
        setActiveTurnId(null);
        setItems([]);
      }
    } catch (e) {
      setErrorBanner(`thread/archive failed: ${rpcErrorText(e)}`);
    }
  };

  const unarchiveThread = async (t: Thread) => {
    try {
      await invoke("rpc_request", { method: "thread/unarchive", params: { threadId: t.id } });
      setThreads((prev) => prev.filter((th) => th.id !== t.id));
    } catch (e) {
      setErrorBanner(`thread/unarchive failed: ${rpcErrorText(e)}`);
    }
  };

  const confirmPendingThreadConnect = async () => {
    const threadId = pendingThreadId;
    setPendingThreadId(null);
    if (!threadId) return;
    const ok = await doConnect();
    if (ok) await resumeThread(threadId);
  };

  const newThread = async () => {
    if (!projectCwd.trim()) {
      setErrorBanner("プロジェクトのWSLパスを選択してください");
      return;
    }
    localStorage.setItem("projectCwd", projectCwd);
    setErrorBanner(null);
    try {
      const raw = await invoke("rpc_request", {
        method: "thread/start",
        params: { cwd: projectCwd.trim(), approvalPolicy },
      });
      const res = parseOrReport(ThreadStartResponseSchema, raw, "thread/start", setErrorBanner);
      if (!res) return;
      discardPastedImages();
      setActiveThreadId(res.thread.id);
      setItems([]);
      setThreadTokenUsage(null);
      await refreshThreads();
    } catch (e) {
      setErrorBanner(`thread/start failed: ${rpcErrorText(e)}`);
    }
  };

  const openTerminalHere = async () => {
    try {
      await invoke("open_wsl_terminal", { distro, path: projectCwd });
    } catch (e) {
      setErrorBanner(`ターミナルを開けませんでした: ${e}`);
    }
  };

  const openExplorerHere = async () => {
    try {
      await invoke("open_in_explorer", { distro, path: projectCwd });
    } catch (e) {
      setErrorBanner(`エクスプローラーを開けませんでした: ${e}`);
    }
  };

  // Native Explorer-style folder picker instead of the flat discovered-list
  // dropdown. WSL is browsable from Windows via the \\wsl.localhost\<distro>
  // UNC form, so the dialog opens there and the chosen path is converted
  // back to a WSL path with the same windows_path_to_wsl command the
  // drag-and-drop handler already uses.
  const browseForProject = async () => {
    try {
      const startUnc = `\\\\wsl.localhost\\${distro}\\${(projectCwd || DEFAULT_PROJECT_PATH)
        .replace(/^\//, "")
        .replace(/\//g, "\\")}`;
      const { open } = await import("@tauri-apps/plugin-dialog");
      const picked = await open({ directory: true, defaultPath: startUnc });
      if (!picked || typeof picked !== "string") return;
      const wslPath = await invoke<string>("windows_path_to_wsl", { path: picked, distro });
      const next = projectPaths.includes(wslPath) ? projectPaths : [...projectPaths, wslPath].sort();
      setProjectPaths(next);
      localStorage.setItem("projectPaths", JSON.stringify(next));
      setProjectCwd(wslPath);
      localStorage.setItem("projectCwd", wslPath);
    } catch (e) {
      setErrorBanner(`フォルダ選択に失敗しました: ${e}`);
    }
  };

  // codex's own model/list is unusable for Ollama (it queries the
  // OpenAI-compat /v1/models endpoint, which fails to parse against
  // Ollama's response shape — see the "failed to refresh available models"
  // error). List installed models directly from Ollama's native /api/tags
  // instead, which also carries each model's real context length so
  // model_context_window can be set correctly without a separate lookup.
  // Fetched via a Rust command (curl.exe) rather than browser fetch(), since
  // the webview's fetch() hits Ollama's CORS restrictions.
  const refreshOllamaModels = async () => {
    setOllamaModelsLoading(true);
    try {
      const models = await invoke<{ name: string; context_length: number | null }[]>("list_ollama_models");
      setOllamaModels(models.map((m) => ({ name: m.name, contextLength: m.context_length })));
    } catch (e) {
      setErrorBanner(`Ollamaのモデル一覧取得に失敗しました（起動していますか？）: ${e}`);
    } finally {
      setOllamaModelsLoading(false);
    }
  };

  const onOllamaModelChange = (name: string) => {
    setOllamaModel(name);
    const found = ollamaModels.find((m) => m.name === name);
    if (found?.contextLength) {
      setOllamaContextWindow(String(found.contextLength));
    }
  };

  useEffect(() => {
    if (provider === "ollama" && ollamaModels.length === 0 && !ollamaModelsLoading) {
      void refreshOllamaModels();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  const stop = async () => {
    if (!activeThreadId || !activeTurnId) return;
    try {
      // F-06: Stop cancels the running turn only; never kills the process.
      await invoke("rpc_request", {
        method: "turn/interrupt",
        params: { threadId: activeThreadId, turnId: activeTurnId },
      });
    } catch (e) {
      setErrorBanner(`turn/interrupt failed: ${rpcErrorText(e)}`);
    }
  };

  const answerApproval = async (req: ServerRequest, decision: ApprovalDecision) => {
    if (approvalRespondingId !== null) return;
    setApprovalRespondingId(req.id);
    try {
      await invoke("respond_server_request", {
        id: req.id,
        result: { decision },
      });
      // The request is consumed only after the response was written. On
      // failure it remains visible so the user can retry the same id.
      setApprovals((prev) => prev.filter((a) => a.id !== req.id));
    } catch (e) {
      setErrorBanner(`承認応答の送信に失敗: ${e}`);
    } finally {
      setApprovalRespondingId(null);
    }
  };

  const openModelPicker = async () => {
    try {
      const raw = await invoke("rpc_request", { method: "model/list", params: {} });
      const res = parseOrReport(ModelListResponseSchema, raw, "model/list", setErrorBanner);
      if (!res) return;
      setModelPicker((res.data as unknown as Model[]).filter((m) => !m.hidden));
    } catch (e) {
      setErrorBanner(`model/list failed: ${rpcErrorText(e)}`);
    }
  };

  const pickModel = (m: Model) => {
    setModelOverride(m.model);
    setModelOverrideLabel(m.displayName);
    setModelPicker(null);
  };

  const clearModelOverride = () => {
    setModelOverride(null);
    setModelOverrideLabel(null);
  };

  // Silent lookup of the account's default model, purely for the footer
  // label when no override is set (openModelPicker still re-fetches fresh
  // data for the picker itself).
  const fetchDefaultModel = useCallback(async () => {
    try {
      const raw = await invoke("rpc_request", { method: "model/list", params: {} });
      const parsed = ModelListResponseSchema.safeParse(raw);
      if (parsed.success) {
        setDefaultModelLabel((parsed.data.data as unknown as Model[]).find((m) => m.isDefault)?.displayName ?? null);
      }
    } catch {
      // silent — footer just falls back to a generic label
    }
  }, []);

  // Silent refresh for the always-on footer badge (no error banner spam —
  // this runs automatically, not on explicit user action).
  const openUsagePanel = async () => {
    await fetchUsage();
    setUsageModalOpen(true);
  };

  const showDiff = async () => {
    if (!projectCwd) {
      setErrorBanner("プロジェクトが選択されていません");
      return;
    }
    try {
      const raw = await invoke("rpc_request", {
        method: "gitDiffToRemote",
        params: { cwd: projectCwd },
      });
      const res = parseOrReport(GitDiffToRemoteResponseSchema, raw, "gitDiffToRemote", setErrorBanner);
      if (!res) return;
      setDiffPanel(res as unknown as { sha: string; diff: string });
    } catch (e) {
      setErrorBanner(`gitDiffToRemote failed: ${rpcErrorText(e)}`);
    }
  };

  const showStatus = async () => {
    if (!activeThreadId) {
      setErrorBanner("スレッドが選択されていません");
      return;
    }
    try {
      const raw = await invoke("rpc_request", {
        method: "thread/read",
        params: { threadId: activeThreadId },
      });
      const res = parseOrReport(ThreadReadResponseSchema, raw, "thread/read", setErrorBanner);
      if (!res) return;
      setStatusPanel(res.thread as unknown as Thread);
    } catch (e) {
      setErrorBanner(`thread/read failed: ${rpcErrorText(e)}`);
    }
  };

  const copyLastResponse = async () => {
    const last = [...items].reverse().find((di) => di.item.type === "agentMessage");
    const text = last ? (last.item as Extract<ThreadItem, { type: "agentMessage" }>).text : "";
    if (!text) {
      setErrorBanner("コピーできる応答がありません");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      setErrorBanner(`クリップボードへのコピーに失敗しました: ${e}`);
    }
  };

  // "/" command palette. Runs a local GUI action; nothing here is text sent
  // to the model (except takesArg commands, which resolve to their own RPC
  // call, not a turn/start). Selecting /model opens a second-level list
  // (modelPicker) instead of executing immediately.
  const slashCommands: { name: string; description: string; takesArg?: boolean; run: (arg?: string) => void }[] = [
    {
      name: "new",
      description: "選択中のプロジェクトで新しいスレッドを作成",
      run: () => void newThread(),
    },
    {
      name: "goal",
      description: "スレッドのゴールを設定（例: /goal ログイン機能を完成させる）",
      takesArg: true,
      run: (arg) => {
        if (!activeThreadId) {
          setErrorBanner("スレッドが選択されていません");
          return;
        }
        if (!arg) {
          setErrorBanner("ゴールの内容を入力してください（例: /goal ログイン機能を完成させる）");
          return;
        }
        void invoke("rpc_request", {
          method: "thread/goal/set",
          params: { threadId: activeThreadId, objective: arg },
        }).catch((e) => setErrorBanner(`thread/goal/set failed: ${rpcErrorText(e)}`));
      },
    },
    {
      name: "compact",
      description: "現在のスレッドの会話を要約して圧縮する",
      run: () => {
        if (!activeThreadId) {
          setErrorBanner("スレッドが選択されていません");
          return;
        }
        void invoke("rpc_request", {
          method: "thread/compact/start",
          params: { threadId: activeThreadId },
        }).catch((e) => setErrorBanner(`thread/compact/start failed: ${rpcErrorText(e)}`));
      },
    },
    {
      name: "diff",
      description: "プロジェクトのgit diffを表示",
      run: () => void showDiff(),
    },
    {
      name: "status",
      description: "現在のスレッドの状態を表示",
      run: () => void showStatus(),
    },
    {
      name: "copy",
      description: "直前のアシスタント応答をクリップボードにコピー",
      run: () => void copyLastResponse(),
    },
    {
      name: "model",
      description: "使用するモデルを選択する",
      run: () => void openModelPicker(),
    },
    {
      name: "stop",
      description: "実行中のturnを中断する（Stopボタンと同じ）",
      run: () => void stop(),
    },
    {
      name: "usage",
      description: "レート制限・トークン使用量を表示",
      run: () => void openUsagePanel(),
    },
    {
      name: "help",
      description: "利用可能なコマンド一覧を表示",
      run: () => setErrorBanner(`利用可能: ${slashCommands.map((c) => "/" + c.name).join("  ")}`),
    },
  ];

  const slashMatch = /^\/([a-zA-Z-]*)$/.exec(input);
  const slashQuery = slashMatch?.[1]?.toLowerCase() ?? null;
  const filteredCommands =
    slashQuery === null
      ? []
      : slashCommands.filter((c) => c.name.startsWith(slashQuery));

  // Parameterless commands run immediately; takesArg commands only complete
  // the input to "/name " so the user can keep typing the argument (executed
  // later from send(), not from the palette).
  const runSlashCommand = (cmd: (typeof slashCommands)[number]) => {
    if (cmd.takesArg) {
      setInput(`/${cmd.name} `);
      setSlashOpen(false);
      setSlashIndex(0);
      return;
    }
    cmd.run();
    setInput("");
    setSlashOpen(false);
    setSlashIndex(0);
  };

  // Ctrl+V with an image on the clipboard: stage it as a thumbnail instead
  // of letting the browser paste garbage bitmap data as text. Actually
  // sending it happens in send(), as UserInput's localImage.
  const handleComposerPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData.items).filter((i) => i.type.startsWith("image/"));
    if (items.length === 0) return;
    e.preventDefault();
    const connectionId = connectionIdRef.current;
    const threadId = activeThreadIdRef.current;
    if (!connectionId || !threadId || connState !== "connected") return;
    const context: ImageContext = { connectionId, distro, threadId };
    const generation = pasteGenerationRef.current;
    for (const item of items) {
      const blob = item.getAsFile();
      if (!blob) continue;
      const ext = item.type.split("/")[1]?.replace("jpeg", "jpg") || "png";
      setImageSavesPending((count) => count + 1);
      void (async () => {
        try {
          const bytes = new Uint8Array(await blob.arrayBuffer());
          const wslPath = await invoke<string>("save_pasted_image", {
            distro: context.distro,
            bytes: Array.from(bytes),
            ext,
          });
          const currentConnectionId = connectionIdRef.current;
          const currentThreadId = activeThreadIdRef.current;
          const stillCurrent =
            generation === pasteGenerationRef.current &&
            currentConnectionId !== null &&
            currentThreadId !== null &&
            sameImageContext(context, {
              connectionId: currentConnectionId,
              distro: distroRef.current,
              threadId: currentThreadId,
            });
          if (!stillCurrent) {
            deletePastedImageFile({ distro: context.distro, wslPath });
            return;
          }
          const image: PastedImage = {
            ...context,
            id: crypto.randomUUID(),
            wslPath,
            previewUrl: URL.createObjectURL(blob),
          };
          setPastedImages((prev) => {
            const next = [...prev, image];
            pastedImagesRef.current = next;
            return next;
          });
        } catch (err) {
          setErrorBanner(`画像の貼り付けに失敗しました: ${err}`);
        } finally {
          setImageSavesPending((count) => Math.max(0, count - 1));
        }
      })();
    }
  };

  const removePastedImage = (id: string) => {
    setPastedImages((prev) => {
      const target = prev.find((p) => p.id === id);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
        deletePastedImageFile(target);
      }
      const next = prev.filter((p) => p.id !== id);
      pastedImagesRef.current = next;
      return next;
    });
  };

  const send = async () => {
    const text = input.trim();
    if ((!text && pastedImages.length === 0) || !activeThreadId || activeTurnId || imageSavesPending > 0) return;

    // "/name <arg>" typed out and submitted with Enter (not selected from
    // the dropdown, which already handled parameterless commands earlier).
    const argMatch = /^\/([a-zA-Z-]+)\s+([\s\S]+)$/.exec(text);
    if (argMatch) {
      const cmd = slashCommands.find((c) => c.name === argMatch[1] && c.takesArg);
      if (cmd) {
        setInput("");
        setErrorBanner(null);
        cmd.run(argMatch[2].trim());
        return;
      }
    }

    const images = pastedImages;
    setInput("");
    setPastedImages([]);
    pastedImagesRef.current = [];
    for (const img of images) URL.revokeObjectURL(img.previewUrl);
    setErrorBanner(null);
    // N-22: prepare-before-send so a crash between here and turn/started
    // still leaves a record that this thread had a turn in flight.
    const requestId = crypto.randomUUID();
    journalPrepare(activeThreadId, requestId);
    if (images.length > 0) imagesAwaitingTurnRef.current = images;
    try {
      // N-17: sends are serialized — input is disabled while a turn runs.
      await invoke("rpc_request", {
        method: "turn/start",
        params: {
          threadId: activeThreadId,
          input: [
            ...images.map((img) => ({ type: "localImage", path: img.wslPath })),
            ...(text ? [{ type: "text", text, text_elements: [] }] : []),
          ],
          ...(modelOverride ? { model: modelOverride } : {}),
        },
      });
      journalMarkSent(activeThreadId, requestId);
    } catch (e) {
      if (shouldAbortJournal(rpcErrorKind(e))) {
        journalAbort(activeThreadId, requestId);
        if (imagesAwaitingTurnRef.current === images) {
          imagesAwaitingTurnRef.current = [];
          for (const image of images) deletePastedImageFile(image);
        }
      }
      setErrorBanner(`turn/start failed: ${rpcErrorText(e)}`);
    }
  };

  // N-05: never send/navigate while IME composition is active.
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;

    if (slashOpen && filteredCommands.length > 0) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % filteredCommands.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === "Tab" || e.key === "Enter") {
        e.preventDefault();
        runSlashCommand(filteredCommands[slashIndex]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSlashOpen(false);
        return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInput(value);
    const open = /^\/[a-zA-Z-]*$/.test(value);
    setSlashOpen(open);
    if (open) setSlashIndex(0);
  };

  // F-02a: the dropdown lists folders explicitly chosen via browseForProject
  // (plus any thread's own cwd encountered on resume) — a plain history,
  // not an automatic scan.
  const onProjectSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    setProjectCwd(e.target.value);
    localStorage.setItem("projectCwd", e.target.value);
  };

  const approval = approvals[0];
  const approvalParams = (approval?.params ?? {}) as CommandApprovalParams;
  const decisions: ApprovalDecision[] =
    approvalParams.availableDecisions ?? ["accept", "decline", "cancel"];
  // item/fileChange/requestApproval carries no file list of its own (spec
  // 7.3) -- the params only say *that* a fileChange item needs approval,
  // not *which files*. The actual list already exists as that item's own
  // "fileChange" ThreadItem (shown inline in the transcript as "File
  // changes (inProgress)"); look it up by itemId so the modal doesn't force
  // the user to go find that item themselves to see what they're approving.
  const approvalFileChangeItem = approvalParams.itemId
    ? items.find((di) => di.item.id === approvalParams.itemId)?.item
    : undefined;
  const approvalFileChange =
    approvalFileChangeItem?.type === "fileChange"
      ? (approvalFileChangeItem as Extract<ThreadItem, { type: "fileChange" }>)
      : undefined;

  return (
    <div className="app">

      {errorBanner && (
        <div className="banner" onClick={() => setErrorBanner(null)}>
          {errorBanner}
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          <section>
            <h3>プロジェクト</h3>
            <label>
              WSLパス（参照で選んだフォルダの履歴）
              <div className="project-path-row">
                <select value={projectCwd} onChange={onProjectSelectChange} title={projectCwd}>
                  {projectPaths.map((p) => (
                    <option key={p} value={p} title={p}>
                      {p}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="mini"
                  onClick={() => void browseForProject()}
                  title="エクスプローラーでフォルダを選択"
                >
                  📂 参照…
                </button>
              </div>
            </label>
            <label>
              承認レベル
              <select
                value={approvalPolicy}
                onChange={onApprovalPolicyChange}
                title="新規スレッド作成時と、接続後にこのセッションで初めて開くスレッドに適用されます。一度開いたスレッドを開き直しても変更は反映されません（一度切断して再接続してください）"
              >

                {APPROVAL_POLICIES.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="project-actions">
              <button onClick={newThread} disabled={connState !== "connected"}>
                新しいスレッド
              </button>
              <button
                className="icon-btn"
                onClick={() => void openTerminalHere()}
                disabled={!projectCwd}
                title="このWSLパスでターミナルを開く"
              >
                ⌨
              </button>
              <button
                className="icon-btn"
                onClick={() => void openExplorerHere()}
                disabled={!projectCwd}
                title="このWSLパスをエクスプローラーで開く"
              >
                📁
              </button>
            </div>
          </section>

          <section className="threads">
            <h3>
              {showArchived ? "スレッド（アーカイブ済み）" : "スレッド"}
              <button
                className="mini"
                onClick={() => setShowArchived((v) => !v)}
                disabled={connState !== "connected"}
                title={showArchived ? "通常のスレッド一覧に戻る" : "アーカイブ済みスレッドを表示"}
              >
                {showArchived ? "戻る" : "🗄"}
              </button>
              <button className="mini" onClick={refreshThreads} disabled={connState !== "connected"}>
                ↻
              </button>
            </h3>
            <ul>
              {threads.map((t) => (
                <li key={t.id} className="thread-row">
                  {renamingThreadId === t.id ? (
                    <input
                      autoFocus
                      className="rename-input"
                      value={renameInput}
                      onChange={(e) => setRenameInput(e.target.value)}
                      onBlur={() => void confirmRename()}
                      onKeyDown={(e) => {
                        if (e.nativeEvent.isComposing) return;
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void confirmRename();
                        } else if (e.key === "Escape") {
                          setRenamingThreadId(null);
                        }
                      }}
                    />
                  ) : (
                    <>
                      <button
                        className={t.id === activeThreadId ? "active" : ""}
                        onClick={() => openThread(t.id)}
                        title={t.cwd}
                      >
                        {(t.name ?? t.preview ?? t.id).slice(0, 40) || "(empty)"}
                      </button>
                      {showArchived ? (
                        <button
                          className="rename-btn"
                          onClick={(e) => {
                            e.stopPropagation();
                            void unarchiveThread(t);
                          }}
                          title="アーカイブから戻す"
                        >
                          ↩
                        </button>
                      ) : (
                        <>
                          <button
                            className="rename-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              startRenaming(t);
                            }}
                            title="スレッド名を変更"
                          >
                            ✎
                          </button>
                          <button
                            className="rename-btn"
                            onClick={(e) => {
                              e.stopPropagation();
                              if (window.confirm(`「${t.name ?? t.preview ?? t.id}」をアーカイブしますか？`)) {
                                void archiveThread(t);
                              }
                            }}
                            title="スレッドをアーカイブ"
                          >
                            🗄
                          </button>
                        </>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
            {threadsNextCursor && (
              <button
                className="mini load-more"
                onClick={() => void loadMoreThreads()}
                disabled={connState !== "connected" || threadsLoadingMore}
              >
                {threadsLoadingMore ? "読み込み中…" : "さらに読み込む"}
              </button>
            )}
          </section>

          <section>
            <h3>接続</h3>
            {connState === "connected" || connState === "disconnecting" ? (
              <button onClick={doDisconnect} disabled={connState === "disconnecting"}>
                {connState === "disconnecting" ? "切断中…" : "切断"}
              </button>
            ) : (
              <>
                <label>
                  WSLディストリ
                  {distros.length > 0 ? (
                    <select value={distro} onChange={(e) => onDistroChange(e.target.value)}>
                      {!distros.some((d) => d.name === distro) && (
                        <option value={distro}>{distro}（未確認）</option>
                      )}
                      {distros.map((d) => (
                        <option key={d.name} value={d.name}>
                          {d.name}
                          {d.is_default ? "（既定）" : ""}
                        </option>
                      ))}
                    </select>
                  ) : (
                    // Fallback when enumeration failed: free text, re-check
                    // codex when focus leaves the field.
                    <input
                      value={distro}
                      onChange={(e) => {
                        setDistro(e.target.value);
                        localStorage.setItem("distro", e.target.value);
                      }}
                      onBlur={() => void resolveCodexPath(distro, codexPath)}
                    />
                  )}
                </label>
                <label>
                  codex絶対パス（WSL内）
                  <input
                    value={codexPath}
                    onChange={(e) => onCodexPathInput(e.target.value)}
                    placeholder="/home/user/.nvm/.../bin/codex"
                  />
                </label>
                <div className="codex-path-status">
                  {codexStatus === "checking" && <span className="checking">codexの場所を確認中…</span>}
                  {codexStatus === "ok" && <span className="ok">✓ codexを確認しました</span>}
                  {codexStatus === "ng" && (
                    <span className="ng">✗ {codexNotice ?? "codexが見つかりません"}</span>
                  )}
                </div>
                <label>
                  プロバイダ
                  <select value={provider} onChange={(e) => setProvider(e.target.value as "openai" | "ollama")}>
                    <option value="openai">OpenAI（既定）</option>
                    <option value="ollama">Ollama（ローカル）</option>
                  </select>
                </label>
                {provider === "ollama" && (
                  <>
                    <label>
                      Ollamaモデル
                      <div className="project-path-row">
                        <select value={ollamaModel} onChange={(e) => onOllamaModelChange(e.target.value)}>
                          {ollamaModels.length === 0 && <option value={ollamaModel}>{ollamaModel}</option>}
                          {ollamaModels.length > 0 &&
                            !ollamaModels.some((m) => m.name === ollamaModel) && (
                              <option value={ollamaModel}>{ollamaModel}（未確認）</option>
                            )}
                          {ollamaModels.map((m) => (
                            <option key={m.name} value={m.name}>
                              {m.name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className="mini"
                          onClick={() => void refreshOllamaModels()}
                          disabled={ollamaModelsLoading}
                          title="Ollamaに問い合わせてインストール済みモデル一覧を再取得"
                        >
                          {ollamaModelsLoading ? "…" : "↻"}
                        </button>
                      </div>
                    </label>
                    <label>
                      コンテキスト長
                      <input
                        value={ollamaContextWindow}
                        onChange={(e) => setOllamaContextWindow(e.target.value)}
                        placeholder="32768"
                        title="モデル選択時にOllamaの実測値を自動反映（手動で上書き可）"
                      />
                    </label>
                  </>
                )}
                <button
                  onClick={doConnect}
                  disabled={connState === "connecting" || codexStatus !== "ok"}
                  title={
                    codexStatus !== "ok"
                      ? "codexの場所が確認できるまで接続できません"
                      : undefined
                  }
                >
                  {connState === "connecting" ? "接続中…" : "接続"}
                </button>
              </>
            )}
          </section>
        </aside>

        <main className="chat">
          <div className="transcript" ref={transcriptRef}>
            {items.map((di) => (
              <TranscriptItem key={di.key} di={di} distro={distro} cwd={projectCwd} onLinkError={setErrorBanner} />
            ))}
            {activeTurnId && <div className="working">Codex is working…</div>}
          </div>
          <div className={`composer-wrap${dragOver ? " drag-over" : ""}`} ref={composerWrapRef}>
            {slashOpen && filteredCommands.length > 0 && (
              <ul className="slash-menu">
                {filteredCommands.map((c, i) => (
                  <li
                    key={c.name}
                    className={i === slashIndex ? "active" : ""}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      runSlashCommand(c);
                    }}
                    onMouseEnter={() => setSlashIndex(i)}
                  >
                    <code>/{c.name}</code>
                    <span>{c.description}</span>
                  </li>
                ))}
              </ul>
            )}
            {pastedImages.length > 0 && (
              <div className="pasted-images">
                {pastedImages.map((img) => (
                  <div key={img.id} className="pasted-image-chip">
                    <img src={img.previewUrl} alt="貼り付けた画像" />
                    <button
                      type="button"
                      className="mini"
                      onClick={() => removePastedImage(img.id)}
                      title="この画像を取り消す"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
            {imageSavesPending > 0 && <div className="working">画像を保存中…</div>}
            <div className="composer">
              <textarea
                ref={composerInputRef}
                value={input}
                onChange={onInputChange}
                onKeyDown={onInputKeyDown}
                onPaste={handleComposerPaste}
                placeholder={
                  activeThreadId
                    ? "メッセージを入力（Enterで送信 / Shift+Enterで改行 / \"/\"でコマンド / 画像はCtrl+Vで貼り付け）"
                    : "先にスレッドを選択または作成してください"
                }
                disabled={connState !== "connected" || !activeThreadId || !!activeTurnId}
                rows={3}
              />
              <button
                onClick={send}
                disabled={
                  (!input.trim() && pastedImages.length === 0) ||
                  !activeThreadId ||
                  !!activeTurnId ||
                  imageSavesPending > 0
                }
              >
                送信
              </button>
            </div>
          </div>
        </main>
      </div>

      {approval && (
        <div className="modal-backdrop">
          <div className="modal">
            <h3>Codexが承認を求めています</h3>
            <p className="method">{approval.method}</p>
            {approvalParams.command && <pre>{approvalParams.command}</pre>}
            {approvalParams.cwd && <p className="cwd">cwd: {approvalParams.cwd}</p>}
            {approvalParams.reason && <p className="reason">{approvalParams.reason}</p>}
            {approvalFileChange && (
              <div className="msg filechange approval-filechange">
                <strong>File changes ({approvalFileChange.status})</strong>
                <ul>
                  {approvalFileChange.changes?.map((c, i) => (
                    <li key={i}>{typeof c.path === "string" ? c.path : JSON.stringify(c)}</li>
                  ))}
                </ul>
              </div>
            )}
            <div className="decisions">
              {decisions.map((d, i) => (
                <button
                  key={i}
                  className={typeof d === "string" && (d === "cancel" || d === "decline") ? "danger" : "primary"}
                  onClick={() => answerApproval(approval, d)}
                  disabled={approvalRespondingId !== null}
                >
                  {decisionLabel(d)}
                </button>
              ))}
            </div>
            {approvals.length > 1 && <p className="queued">他に{approvals.length - 1}件の承認待ちがあります</p>}
          </div>
        </div>
      )}

      {modelPicker && (
        <div className="modal-backdrop" onClick={() => setModelPicker(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>モデルを選択</h3>
            <ul className="model-list">
              {modelPicker.map((m) => (
                <li key={m.id}>
                  <button onClick={() => pickModel(m)}>
                    <strong>{m.displayName}</strong>
                    {m.isDefault && <span className="tag">既定</span>}
                    <span className="desc">{m.description}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button className="mini" onClick={() => setModelPicker(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {pendingThreadId && (
        <div className="modal-backdrop" onClick={() => setPendingThreadId(null)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <h3>接続しますか？</h3>
            <p>このスレッドを開くにはCodexサーバーへ接続する必要があります。</p>
            <div className="decisions">
              <button className="primary" onClick={() => void confirmPendingThreadConnect()}>
                はい
              </button>
              <button className="danger" onClick={() => setPendingThreadId(null)}>
                いいえ
              </button>
            </div>
          </div>
        </div>
      )}

      {usageModalOpen && usagePanel && (
        <div className="modal-backdrop" onClick={() => setUsageModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>使用量</h3>
            <UsageWindow label="Primary" w={usagePanel.rateLimits.primary} />
            <UsageWindow label="Secondary" w={usagePanel.rateLimits.secondary} />
            {threadTokenUsage && (
              <>
                <p className="usage-subhead">現在のスレッド</p>
                <ul className="usage-tokens">
                  <li>合計: {threadTokenUsage.total.totalTokens.toLocaleString()} tokens</li>
                  <li>入力: {threadTokenUsage.total.inputTokens.toLocaleString()}（キャッシュ {threadTokenUsage.total.cachedInputTokens.toLocaleString()}）</li>
                  <li>出力: {threadTokenUsage.total.outputTokens.toLocaleString()}</li>
                  {threadTokenUsage.modelContextWindow && (
                    <li>コンテキストウィンドウ: {threadTokenUsage.modelContextWindow.toLocaleString()}</li>
                  )}
                </ul>
              </>
            )}
            <button className="mini" onClick={() => setUsageModalOpen(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {diffPanel && (
        <div className="modal-backdrop" onClick={() => setDiffPanel(null)}>
          <div className="modal wide" onClick={(e) => e.stopPropagation()}>
            <h3>git diff</h3>
            <p className="cwd">対リモートSHA: {diffPanel.sha}</p>
            <pre className="diff-view">{diffPanel.diff || "(差分なし)"}</pre>
            <button className="mini" onClick={() => setDiffPanel(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {statusPanel && (
        <div className="modal-backdrop" onClick={() => setStatusPanel(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>スレッド状態</h3>
            <ul className="usage-tokens">
              <li>ID: {statusPanel.id}</li>
              <li>名前: {statusPanel.name ?? "(未設定)"}</li>
              <li>cwd: {statusPanel.cwd}</li>
              <li>状態: {statusPanel.status.type}</li>
              <li>更新日時: {new Date(statusPanel.updatedAt * 1000).toLocaleString()}</li>
              <li>turn数: {statusPanel.turns.length}</li>
            </ul>
            <button className="mini" onClick={() => setStatusPanel(null)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {stderrLog.length > 0 && (
        <details className="stderr">
          <summary>サーバー診断ログ ({stderrLog.length})</summary>
          <pre>{stderrLog.join("\n")}</pre>
        </details>
      )}

      <footer className="statusbar">
        {appVersion && <span className="app-version">WslCodexGui v{appVersion}</span>}
        <span className={`dot ${connState}`} />
        <span>
          {connState === "connected"
            ? "Codex server connected (owned)"
            : connState === "disconnecting"
              ? "切断中…"
              : connState}
        </span>
        <span>WSL: {distro}</span>
        {initInfo && <span>{initInfo.userAgent.split(" ")[0]}</span>}
        {activeThreadId && <span>Thread: {activeThreadId.slice(0, 13)}…</span>}
        {provider === "ollama" && connState === "connected" && (
          <span className="model-footer">🦙 {ollamaModel}</span>
        )}
        {provider !== "ollama" && connState === "connected" && (
          <span className="model-footer">
            <button
              className="model-footer-badge"
              onClick={() => void openModelPicker()}
              title="モデルを変更"
            >
              🧠 {modelOverrideLabel ?? defaultModelLabel ?? "モデル"}
            </button>
            {modelOverride && (
              <button className="mini" onClick={clearModelOverride} title="既定モデルに戻す">
                ×
              </button>
            )}
          </span>
        )}
        {provider !== "ollama" && usagePanel && (
          <button className="usage-badge" onClick={() => void openUsagePanel()} title={usageResetTooltip(usagePanel)}>
            <UsagePill label="P" pct={usagePanel.rateLimits.primary?.usedPercent} />
            {usagePanel.rateLimits.secondary && (
              <UsagePill label="S" pct={usagePanel.rateLimits.secondary?.usedPercent} />
            )}
          </button>
        )}
        {activeTurnId && (
          <button className="stop" onClick={stop}>
            ■ Stop
          </button>
        )}
      </footer>
    </div>
  );
}

// Detail (reset date/time) as a hover tooltip on the always-visible footer
// badge, since the badge itself only has room for the compact "残り%" pills.
function usageResetTooltip(usagePanel: GetAccountRateLimitsResponse): string {
  const lines: string[] = [];
  const primary = usagePanel.rateLimits.primary;
  const secondary = usagePanel.rateLimits.secondary;
  if (primary?.resetsAt) lines.push(`P リセット: ${new Date(primary.resetsAt * 1000).toLocaleString()}`);
  if (secondary?.resetsAt) lines.push(`S リセット: ${new Date(secondary.resetsAt * 1000).toLocaleString()}`);
  return lines.length > 0 ? lines.join("\n") : "使用量の詳細を表示";
}

// Codex公式GUI（利用制限画面）は「残り○%」表記なので、それに合わせる
// （APIが返すのはusedPercentなので、表示直前に反転する）。
function UsagePill({ label, pct }: { label: string; pct: number | undefined }) {
  if (pct === undefined) return null;
  const remaining = Math.round(100 - pct);
  const cls = remaining <= 10 ? "danger" : remaining <= 30 ? "warn" : "";
  return (
    <span className={`usage-pill ${cls}`}>
      {label} 残{remaining}%
    </span>
  );
}

function UsageWindow({ label, w }: { label: string; w: import("./types").RateLimitWindow | null }) {
  if (!w) return null;
  const remaining = Math.round(100 - w.usedPercent);
  const resets = w.resetsAt ? new Date(w.resetsAt * 1000).toLocaleString() : null;
  return (
    <div className="usage-window">
      <div className="usage-window-head">
        <span>
          {label}
          {w.windowDurationMins ? `（${Math.round(w.windowDurationMins / 60)}時間窓）` : ""}
        </span>
        <span>残り{remaining}%</span>
      </div>
      <div className="usage-bar">
        <div
          className={`usage-bar-fill ${remaining <= 10 ? "danger" : remaining <= 30 ? "warn" : ""}`}
          style={{ width: `${Math.max(0, Math.min(remaining, 100))}%` }}
        />
      </div>
      {resets && <p className="usage-reset">リセット: {resets}</p>}
    </div>
  );
}

// A relative (non-URL) markdown link, resolved against the thread's cwd.
function resolveAbsoluteWslPath(href: string, cwd: string): string {
  return href.startsWith("/") ? href : `${cwd.replace(/\/$/, "")}/${href.replace(/^\.\//, "")}`;
}

function wslPathToUnc(absolute: string, distro: string): string {
  return `\\\\wsl.localhost\\${distro}\\${absolute.replace(/^\//, "").replace(/\//g, "\\")}`;
}

const isSchemeUrl = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

// A bare <a href> inside markdown navigates the whole webview away from the
// SPA when clicked (Tauri doesn't intercept in-page link clicks) -- from the
// user's perspective the app just "resets", losing all in-memory state.
// Intercept it instead: absolute URLs open in the default browser/app;
// anything else is treated as a WSL-relative path (codex often links build
// artifacts this way) and opened via Explorer's \\wsl.localhost UNC form.
// File links also get a right-click menu to reveal the containing folder
// instead of opening the file itself.
function MarkdownLink({
  href,
  children,
  distro,
  cwd,
  onLinkError,
  ...props
}: React.ComponentProps<"a"> & { distro: string; cwd: string; onLinkError: (msg: string) => void }) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const isFileLink = !!href && !isSchemeUrl(href);

  return (
    <>
      <a
        {...props}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          if (!href) return;
          void (async () => {
            try {
              if (isSchemeUrl(href)) {
                const { openUrl } = await import("@tauri-apps/plugin-opener");
                await openUrl(href);
              } else {
                const { openPath } = await import("@tauri-apps/plugin-opener");
                await openPath(wslPathToUnc(resolveAbsoluteWslPath(href, cwd), distro));
              }
            } catch (err) {
              onLinkError(`リンクを開けませんでした（${href}）: ${err}`);
            }
          })();
        }}
        onContextMenu={(e) => {
          if (!isFileLink) return;
          e.preventDefault();
          setMenuPos({ x: e.clientX, y: e.clientY });
        }}
      >
        {children}
      </a>
      {menuPos && (
        <>
          <div className="context-menu-backdrop" onClick={() => setMenuPos(null)} />
          <div className="context-menu" style={{ left: menuPos.x, top: menuPos.y }}>
            <button
              onClick={() => {
                setMenuPos(null);
                void (async () => {
                  try {
                    await invoke("reveal_in_explorer", { distro, path: resolveAbsoluteWslPath(href!, cwd) });
                  } catch (err) {
                    onLinkError(`エクスプローラーで開けませんでした（${href}）: ${err}`);
                  }
                })();
              }}
            >
              エクスプローラーでリンク先のフォルダを開く
            </button>
          </div>
        </>
      )}
    </>
  );
}

function markdownLinkComponents(distro: string, cwd: string, onLinkError: (msg: string) => void) {
  return {
    a: (props: React.ComponentProps<"a">) => (
      <MarkdownLink {...props} distro={distro} cwd={cwd} onLinkError={onLinkError} />
    ),
  };
}

function TranscriptItem({
  di,
  distro,
  cwd,
  onLinkError,
}: {
  di: DisplayItem;
  distro: string;
  cwd: string;
  onLinkError: (msg: string) => void;
}) {
  const { item, streamingText } = di;
  const mdComponents = markdownLinkComponents(distro, cwd, onLinkError);
  switch (item.type) {
    case "userMessage": {
      const text = (item as Extract<ThreadItem, { type: "userMessage" }>).content
        .map((c) => c.text ?? "")
        .join("");
      return <div className="msg user">{text}</div>;
    }
    case "agentMessage": {
      const it = item as Extract<ThreadItem, { type: "agentMessage" }>;
      const text = it.text || streamingText || "";
      return (
        <div className="msg agent md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{text}</ReactMarkdown>
        </div>
      );
    }
    case "reasoning": {
      const it = item as Extract<ThreadItem, { type: "reasoning" }>;
      const summary = it.summary?.join("\n") ?? "";
      if (!summary) return null;
      return (
        <div className="msg reasoning md">
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{summary}</ReactMarkdown>
        </div>
      );
    }
    case "commandExecution": {
      const it = item as Extract<ThreadItem, { type: "commandExecution" }>;
      return (
        <div className="msg command">
          <code>$ {it.command}</code>
          {(it.aggregatedOutput || streamingText) && (
            <pre>{it.aggregatedOutput ?? streamingText}</pre>
          )}
          {it.exitCode !== null && it.exitCode !== undefined && (
            <span className={`exit ${it.exitCode === 0 ? "ok" : "err"}`}>exit {it.exitCode}</span>
          )}
        </div>
      );
    }
    case "fileChange": {
      const it = item as Extract<ThreadItem, { type: "fileChange" }>;
      return (
        <div className="msg filechange">
          <strong>File changes ({it.status})</strong>
          <ul>
            {it.changes?.map((c, i) => (
              <li key={i}>{typeof c.path === "string" ? c.path : JSON.stringify(c)}</li>
            ))}
          </ul>
        </div>
      );
    }
    default:
      return null; // unknown item kinds are silently skipped (N-10)
  }
}
