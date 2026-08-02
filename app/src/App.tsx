import { memo, useCallback, useEffect, useRef, useState } from "react";
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
  ReasoningSummaryPartAddedSchema,
  ReasoningSummaryTextDeltaSchema,
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
import { formatLinkAddress, splitLineSuffix } from "./linkTarget";
import { forcedEffortForModel } from "./modelEffort";
import { turnModelFields } from "./turnModelFields";
import { creditBadge } from "./creditBadge";
import { IDLE_POLL_INTERVAL_MS, inputDetected, shouldNotifyOnTurnEnd } from "./idleNotice";
import { formatElapsed } from "./formatElapsed";
import { itemToText, transcriptToText } from "./transcriptCopy";
import {
  appendSummaryDelta,
  liveReasoningText,
  startSummaryPart,
  type LiveReasoning,
} from "./liveReasoning";
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
// Sticks on every connect until the user picks something else via the 🧠
// footer badge (openModelPicker/pickModel) — only applies to the OpenAI
// provider; Ollama has its own separate model field.
const DEFAULT_MODEL_OVERRIDE = "gpt-5.6-luna";
const DEFAULT_MODEL_OVERRIDE_LABEL = "GPT-5.6-Luna";

// Pre-connect model choices (model/list needs a live connection, so this is
// a small curated set rather than the live catalog -- confirmed current via
// a real model/list probe on 2026-07-27). Any other value (typed pre-connect
// via the fallback text input, or picked post-connect from the live 🧠
// picker) still shows up as an extra "(未確認)" option, same pattern as the
// WSL distro select's fallback.
const MODEL_PRESETS: { value: string; label: string }[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6-Sol" },
  { value: "gpt-5.6-terra", label: "GPT-5.6-Terra" },
  { value: "gpt-5.6-luna", label: "GPT-5.6-Luna" },
];

// thread/start's approvalPolicy, fixed for the lifetime of a thread (cannot
// be changed on thread/resume). "granular" also exists server-side but is
// undocumented in `codex --help` and not exposed here.
type ApprovalPolicy = "untrusted" | "on-request" | "never";
const APPROVAL_POLICIES: { value: ApprovalPolicy; label: string }[] = [
  { value: "untrusted", label: "信頼済みコマンドのみ自動実行（それ以外は確認）" },
  { value: "on-request", label: "モデルが必要と判断した時だけ確認（既定）" },
  { value: "never", label: "確認なし（実行失敗はそのままモデルに返る）" },
];

// turn/start's `effort`/`serviceTier` (spec: app-server generate-json-schema's
// TurnStartParams) override "for this turn and subsequent turns" -- unlike
// approvalPolicy these are NOT fixed for a thread's lifetime, so they can be
// changed mid-connection and simply take effect on the next message sent.
// Kept as a fixed list here (not fetched from model/list's per-model
// supportedReasoningEfforts/serviceTiers) so a value can be picked before
// connecting too, when there's no live app-server to query yet -- the
// tradeoff is a model that doesn't support a picked level will surface as an
// ordinary turn/start error via the existing errorBanner path rather than
// being filtered out in advance.
type ReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max";
const REASONING_EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: "low", label: "軽" },
  { value: "medium", label: "中程度" },
  { value: "high", label: "高い" },
  { value: "xhigh", label: "非常に高い" },
  { value: "max", label: "最大" },
];

// How often the footer's usage badge re-reads account/rateLimits/read while
// a turn is running. Slow on purpose: the quota moves in whole percent
// points over minutes, so anything tighter would add requests without
// changing what the badge shows.
const USAGE_POLL_INTERVAL_MS = 30_000;

// Reasoning level an Ollama session falls back to, replacing whatever
// ~/.codex/config.toml holds (see the connect-time override below). "high"
// is the nearest level Ollama accepts to this environment's configured
// "xhigh", which sits between "high" and "max".
const OLLAMA_DEFAULT_EFFORT: ReasoningEffort = "high";

// turn/start's `summary` ("auto" | "concise" | "detailed" | "none"), sent on
// every turn like effort/serviceTier. Not a user setting: without it, this
// environment's codex produced *no* reasoning summary at all -- verified
// against a live app-server on 2026-08-02, where a turn spawned the way this
// app spawns it delivered `reasoning` items with `summary: []` and zero
// item/reasoning/* notifications, while the same turn under
// `-c model_reasoning_summary="detailed"` streamed them. Both the live
// 推論経過 pane and the transcript's own reasoning bubbles are empty without
// it, so the app asks for summaries rather than depending on the user's
// ~/.codex/config.toml.
const REASONING_SUMMARY = "detailed";

type ServiceTier = "default" | "priority";
const SERVICE_TIERS: { value: ServiceTier; label: string }[] = [
  { value: "default", label: "標準" },
  { value: "priority", label: "高速（1.5倍速、使用量多め）" },
];

// codex's own trust list (~/.codex/config.toml [projects]) decides sandbox
// per exact cwd path with no inheritance from a trusted parent -- a project
// folder picked here that isn't separately trusted via the codex CLI (which
// this GUI has no equivalent flow for) silently defaults to a read-only
// sandbox, so every write fails and, under approvalPolicy "never", fails
// *silently* with no chance to escalate. Deliberately choosing a WSL path in
// this app's project picker is itself the trust decision, so we always send
// workspace-write here rather than deferring to codex's own trust list --
// approvalPolicy is unaffected and still governs whether commands need
// confirmation; this only controls what's technically permitted to execute.
const PROJECT_SANDBOX = "workspace-write";

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

// codex's stderr uses ANSI color/style codes for its own terminal logging
// (e.g. `\x1b[31mERROR\x1b[0m`), which render as literal garbage escape
// sequences in a plain <pre> instead of color. Strip them rather than
// interpret them -- this log is a diagnostics dump, not a terminal emulator.
const ANSI_ESCAPE_RE = new RegExp(
  "[\x1b\x9b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]",
  "g"
);
function stripAnsi(s: string): string {
  return s.replace(ANSI_ESCAPE_RE, "");
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
  // "wsl" (original): app-server runs inside a WSL2 distro via wsl.exe.
  // "native": app-server is a codex CLI installed directly on Windows,
  // spawned without wsl.exe (see appserver.rs's Connection::spawn branch).
  // Kept as a distinct localStorage key per path-shaped field below
  // (codexPath/projectPaths/projectCwd) since WSL paths ("/home/...") and
  // Windows paths ("C:\...") are never interchangeable.
  const [connectionMode, setConnectionModeState] = useState<"wsl" | "native">(
    () => (localStorage.getItem("connectionMode") as "wsl" | "native" | null) ?? "wsl"
  );
  const codexPathStorageKey = connectionMode === "native" ? "codexPathNative" : "codexPath";
  const projectPathsStorageKey = connectionMode === "native" ? "projectPathsNative" : "projectPaths";
  const projectCwdStorageKey = connectionMode === "native" ? "projectCwdNative" : "projectCwd";

  const [distro, setDistro] = useState(() => localStorage.getItem("distro") ?? "Ubuntu-24.04");
  const [distros, setDistros] = useState<WslDistroInfo[]>([]);
  const [codexPath, setCodexPath] = useState(
    () => localStorage.getItem(codexPathStorageKey) ?? (connectionMode === "native" ? "" : DEFAULT_CODEX_PATH)
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
    loadStringList(projectPathsStorageKey, connectionMode === "native" ? [] : [DEFAULT_PROJECT_PATH])
  );
  const [projectCwd, setProjectCwd] = useState(
    () =>
      localStorage.getItem(projectCwdStorageKey) ??
      loadStringList(projectPathsStorageKey, connectionMode === "native" ? [] : [DEFAULT_PROJECT_PATH])[0] ??
      ""
  );
  // Applies the next time a thread is first loaded by the running
  // app-server process (new thread, or an existing thread not yet opened
  // this connection) -- confirmed live that thread/resume's approvalPolicy
  // override is otherwise ignored once that process already has the thread
  // loaded. threadApprovalPolicies below tracks which policy each thread
  // actually ended up loaded with, per connection.
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy>(() => {
    const stored = localStorage.getItem("approvalPolicy");
    return APPROVAL_POLICIES.some((p) => p.value === stored) ? (stored as ApprovalPolicy) : "on-request";
  });
  const onApprovalPolicyChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value as ApprovalPolicy;
    setApprovalPolicy(value);
    localStorage.setItem("approvalPolicy", value);
  };
  // Reset on every (re)connect -- a fresh app-server process means every
  // thread is "not yet loaded" again, so the lock resets too.
  const [threadApprovalPolicies, setThreadApprovalPolicies] = useState<Record<string, ApprovalPolicy>>({});

  const [connState, setConnState] = useState<ConnState>("disconnected");
  // Deliberately NOT persisted -- every fresh app launch should start on the
  // minimal connect-only view again, per spec. Flips true the first time a
  // connect() succeeds and stays true for the rest of this app session, so a
  // later manual disconnect still shows the full layout (thread list stays
  // clickable-to-reconnect, per the existing F-09/8.1 behavior) instead of
  // collapsing back down.
  const [hasEverConnected, setHasEverConnected] = useState(false);
  const [initInfo, setInitInfo] = useState<InitializeResponse | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  // F-09a: cursor from the most recent page fetched (null once thread/list
  // has said there's nothing more). Reset to unknown ("has more" assumed)
  // whenever the visible list is rebuilt from scratch by refreshThreads.
  const [threadsNextCursor, setThreadsNextCursor] = useState<string | null | undefined>(undefined);
  const [threadsLoadingMore, setThreadsLoadingMore] = useState(false);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  // Transient ✅ on the whole-transcript copy button.
  const [copiedAll, setCopiedAll] = useState(false);
  // Reasoning summary streamed during the running turn, shown in a pane that
  // exists only while that turn does (the finished text lands in the
  // transcript as a normal reasoning item anyway).
  const [liveReasoning, setLiveReasoning] = useState<LiveReasoning | null>(null);
  const [liveReasoningOpen, setLiveReasoningOpen] = useState(
    () => localStorage.getItem("liveReasoningOpen") !== "false"
  );
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
  const [modelOverride, setModelOverride] = useState<string | null>(
    () => localStorage.getItem("modelOverride") ?? DEFAULT_MODEL_OVERRIDE
  );
  const [modelOverrideLabel, setModelOverrideLabel] = useState<string | null>(
    () => localStorage.getItem("modelOverrideLabel") ?? DEFAULT_MODEL_OVERRIDE_LABEL
  );
  const [defaultModelLabel, setDefaultModelLabel] = useState<string | null>(null);
  // null means "don't override -- use whatever config.toml/account already
  // defaults to" (same semantics turn/start gives a missing effort/serviceTier
  // field). Persisted so a pick sticks across reconnects, same as modelOverride.
  const [reasoningEffort, setReasoningEffortState] = useState<ReasoningEffort | null>(() => {
    const stored = localStorage.getItem("reasoningEffort");
    return REASONING_EFFORTS.some((r) => r.value === stored) ? (stored as ReasoningEffort) : null;
  });
  const onReasoningEffortChange = (value: string) => {
    const next = REASONING_EFFORTS.some((r) => r.value === value) ? (value as ReasoningEffort) : null;
    setReasoningEffortState(next);
    if (next) localStorage.setItem("reasoningEffort", next);
    else localStorage.removeItem("reasoningEffort");
  };
  const [serviceTier, setServiceTierState] = useState<ServiceTier | null>(() => {
    const stored = localStorage.getItem("serviceTier");
    return SERVICE_TIERS.some((s) => s.value === stored) ? (stored as ServiceTier) : null;
  });
  const onServiceTierChange = (value: string) => {
    const next = SERVICE_TIERS.some((s) => s.value === value) ? (value as ServiceTier) : null;
    setServiceTierState(next);
    if (next) localStorage.setItem("serviceTier", next);
    else localStorage.removeItem("serviceTier");
  };
  const [effortPickerOpen, setEffortPickerOpen] = useState(false);
  const [speedPickerOpen, setSpeedPickerOpen] = useState(false);
  // Toggles the pre-connect モデル field between MODEL_PRESETS' <select> and
  // a free-text <input> for an ID outside that curated list.
  const [modelCustomEntry, setModelCustomEntry] = useState(false);
  // What config/read actually reported as the server's currently-effective
  // model_reasoning_effort/service_tier -- distinct from reasoningEffort's
  // own null-ness (which just means "this app isn't overriding it"). Queried
  // at most once per connection (configSyncedRef), the first time either
  // picker is opened, so opening it repeatedly doesn't re-fetch. Reset on
  // every (re)connect since a fresh app-server process may read a
  // config.toml that changed since the last connection.
  const configSyncedRef = useRef(false);
  const [effortServerValue, setEffortServerValue] = useState<string | null>(null);
  const [serviceTierServerValue, setServiceTierServerValue] = useState<string | null>(null);
  const syncServerConfigOnce = async () => {
    if (configSyncedRef.current) return;
    configSyncedRef.current = true;
    try {
      const raw = await invoke<{ config?: Record<string, unknown> }>("rpc_request", {
        method: "config/read",
        params: {},
      });
      const cfg = raw?.config ?? {};
      setEffortServerValue(typeof cfg.model_reasoning_effort === "string" ? cfg.model_reasoning_effort : null);
      setServiceTierServerValue(typeof cfg.service_tier === "string" ? cfg.service_tier : null);
    } catch {
      // silent -- the picker just won't show a "現在のサーバー値" hint
    }
  };
  const openEffortPicker = () => {
    setEffortPickerOpen(true);
    void syncServerConfigOnce();
  };
  const openSpeedPicker = () => {
    setSpeedPickerOpen(true);
    void syncServerConfigOnce();
  };
  const [threadTokenUsage, setThreadTokenUsage] = useState<ThreadTokenUsage | null>(null);
  const [usagePanel, setUsagePanel] = useState<GetAccountRateLimitsResponse | null>(null);
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  // Codex CLI updates often; nagging on every connect until this app's own
  // allowlist catches up would be worse than useless. Warn once per new
  // version actually seen, then remember it was acknowledged and never ask
  // again for that exact version.
  const [acknowledgedCodexVersions, setAcknowledgedCodexVersions] = useState<string[]>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem("acknowledgedCodexVersions") ?? "[]");
      return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
    } catch {
      return [];
    }
  });
  const [unconfirmedVersionModal, setUnconfirmedVersionModal] = useState<string | null>(null);
  const dismissVersionWarning = (version: string) => {
    setUnconfirmedVersionModal(null);
    setAcknowledgedCodexVersions((prev) => {
      if (prev.includes(version)) return prev;
      const next = [...prev, version];
      localStorage.setItem("acknowledgedCodexVersions", JSON.stringify(next));
      return next;
    });
  };
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);
  // window.confirm() does not reliably render in this app's WebView2 host
  // (observed on a real machine: it silently resolves without ever showing
  // a dialog) -- use an in-app modal instead, same pattern as pendingThreadId.
  const [pendingPolicyReopen, setPendingPolicyReopen] = useState<{
    threadId: string;
    appliedPolicy: ApprovalPolicy;
  } | null>(null);
  const [pendingArchive, setPendingArchive] = useState<Thread | null>(null);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [renameInput, setRenameInput] = useState("");
  const [diffPanel, setDiffPanel] = useState<{ sha: string; diff: string } | null>(null);
  const [statusPanel, setStatusPanel] = useState<Thread | null>(null);

  // Refs mirroring state that event handlers need without re-subscribing.
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;
  const distroRef = useRef(distro);
  distroRef.current = distro;
  const connectionModeRef = useRef(connectionMode);
  connectionModeRef.current = connectionMode;
  const pastedImagesRef = useRef<PastedImage[]>([]);
  pastedImagesRef.current = pastedImages;
  const pasteGenerationRef = useRef(0);
  const imagesAwaitingTurnRef = useRef<PastedImage[]>([]);
  const turnImagesRef = useRef<Map<string, PastedImage[]>>(new Map());
  // Elapsed time display while a turn runs. Recorded at turn/started.
  const turnStartTimeRef = useRef<number | null>(null);
  const [elapsedTime, setElapsedTime] = useState(0);

  // Tags the Connection currently considered "live". Every Rust-emitted
  // event carries connectionId; events from a Connection we've already
  // replaced (e.g. its delayed "disconnected" arriving after a new
  // connect() already succeeded) are ignored instead of corrupting state.
  const connectionIdRef = useRef<string | null>(null);

  // Native window titlebar (not document.title, which only affects the
  // in-page <title> and has no effect on the OS chrome) shows the GUI
  // version so it's visible without digging into the footer.
  //
  // Needs `core:window:allow-set-title` in capabilities/default.json --
  // setTitle is not part of core:default, so without it this rejects and the
  // titlebar silently keeps tauri.conf.json's static name. Verified by
  // reading the real title back with PowerShell's MainWindowTitle, which is
  // the only check that catches this (tsc and the unit tests cannot).
  useEffect(() => {
    void (async () => {
      try {
        const [{ getVersion }, { getCurrentWindow }] = await Promise.all([
          import("@tauri-apps/api/app"),
          import("@tauri-apps/api/window"),
        ]);
        const version = await getVersion();
        await getCurrentWindow().setTitle(`WSL Codex GUI v${version}`);
      } catch (e) {
        // Expected under the dev server (no Tauri runtime): the titlebar just
        // keeps the static fallback. Anywhere else this is a real failure, so
        // don't swallow it completely -- a silent catch here is what hid the
        // missing capability above through two builds.
        console.error("failed to set the window title", e);
      }
    })();
  }, []);

  const deletePastedImageFile = useCallback((image: Pick<PastedImage, "distro" | "wslPath">) => {
    void invoke("delete_pasted_image", {
      connectionMode: connectionModeRef.current,
      distro: image.distro,
      path: image.wslPath,
    }).catch((error) => {
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

  // "Turn finished while you were away" notice. Refs rather than state: the
  // notification listener is registered once per connection and must always
  // see the current flashing state, and nothing here needs to re-render.
  const flashingRef = useRef(false);
  const flashPollRef = useRef<number | null>(null);

  // Update elapsed time while a turn is running. Timer runs every 100ms
  // (tight enough for smooth display, loose enough to not spam setState).
  useEffect(() => {
    if (!activeTurnId || !turnStartTimeRef.current) {
      setElapsedTime(0);
      return;
    }
    const interval = window.setInterval(() => {
      if (turnStartTimeRef.current) {
        setElapsedTime(Date.now() - turnStartTimeRef.current);
      }
    }, 100);
    return () => window.clearInterval(interval);
  }, [activeTurnId]);

  const stopFlashing = useCallback(() => {
    if (flashPollRef.current !== null) {
      window.clearInterval(flashPollRef.current);
      flashPollRef.current = null;
    }
    if (!flashingRef.current) return;
    flashingRef.current = false;
    void (async () => {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().requestUserAttention(null);
    })().catch(() => {
      // Nothing useful to tell the user if merely *stopping* the flash fails.
    });
  }, []);

  // Flash only if the desktop itself has been idle -- someone who has been
  // moving the mouse can see the turn finish on their own. Once flashing,
  // poll the same counter and stop at the first sign of input anywhere.
  const notifyTurnEndIfIdle = useCallback(() => {
    void (async () => {
      try {
        const idle = await invoke<number>("system_idle_millis");
        if (!shouldNotifyOnTurnEnd(idle)) return;
        const { getCurrentWindow, UserAttentionType } = await import("@tauri-apps/api/window");
        await getCurrentWindow().requestUserAttention(UserAttentionType.Critical);
        flashingRef.current = true;
        let previousIdle = idle;
        flashPollRef.current = window.setInterval(() => {
          void (async () => {
            try {
              const current = await invoke<number>("system_idle_millis");
              if (inputDetected(previousIdle, current)) stopFlashing();
              else previousIdle = current;
            } catch {
              stopFlashing(); // can't tell any more -- don't flash forever
            }
          })();
        }, IDLE_POLL_INTERVAL_MS);
      } catch {
        // Idle state unavailable: skip the notice rather than flash blindly.
      }
    })();
  }, [stopFlashing]);

  useEffect(() => stopFlashing, [stopFlashing]);

  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, activeTurnId]);

  // The live reasoning pane follows its own tail, independently of the
  // transcript's scroll position.
  const liveReasoningShown = liveReasoningText(liveReasoning);
  const liveReasoningRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = liveReasoningRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveReasoningShown]);

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
  // (windows_path_to_wsl) and insert them into the composer. A drop anywhere in
  // the window is accepted (see the "drop" branch below), so the highlight is
  // the whole window too -- highlighting only the composer suggested a target
  // the user had to hit, which is not how it behaves.
  const [dragOver, setDragOver] = useState(false);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      const un = await getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload;
        if (p.type === "enter" || p.type === "over") {
          setDragOver(true);
          return;
        }
        if (p.type === "leave") {
          setDragOver(false);
          return;
        }
        if (p.type === "drop") {
          setDragOver(false);
          // Composer is the only drop target this app has, so accept a drop
          // anywhere in the window rather than gating on position — position
          // gating used to disagree with the drop event's own coordinates and
          // silently swallowed otherwise-valid drops.
          void (async () => {
            // Native mode: app-server reads plain Windows paths directly, no
            // WSL UNC conversion needed.
            if (connectionModeRef.current === "native") {
              setInput((prev) => (prev ? `${prev} ${p.paths.join(" ")}` : p.paths.join(" ")));
              return;
            }
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

  // Native-mode counterpart to resolveCodexPath: no distro, verifies/detects
  // a codex installed directly on Windows via detect_codex_path_native /
  // verify_codex_path_native.
  const resolveCodexPathNative = useCallback(async (candidate: string | null) => {
    const gen = ++codexCheckGenRef.current;
    window.clearTimeout(verifyTimerRef.current);
    setCodexStatus("checking");
    setCodexNotice(null);
    try {
      if (candidate?.trim()) {
        const ok = await invoke<boolean>("verify_codex_path_native", { path: candidate.trim() });
        if (gen !== codexCheckGenRef.current) return;
        if (ok) {
          setCodexPath(candidate.trim());
          setCodexStatus("ok");
          return;
        }
      }
      const found = await invoke<string | null>("detect_codex_path_native");
      if (gen !== codexCheckGenRef.current) return;
      if (found) {
        setCodexPath(found);
        setCodexStatus("ok");
      } else {
        setCodexPath("");
        setCodexStatus("ng");
        setCodexNotice(
          "Windows側でcodexが見つかりませんでした。PowerShellで `where codex` を実行し、表示された絶対パス（拡張子.cmdのものを推奨）を手入力してください。"
        );
      }
    } catch (e) {
      if (gen !== codexCheckGenRef.current) return;
      setCodexStatus("ng");
      setCodexNotice(`codexパスの確認に失敗しました: ${e}`);
    }
  }, []);

  // Startup: enumerate installed WSL distros, preselect the stored one if it
  // still exists (else the WSL default), then resolve its codex path. Native
  // mode has no distro concept, so it resolves directly from storage.
  useEffect(() => {
    if (connectionModeRef.current === "native") {
      void resolveCodexPathNative(localStorage.getItem("codexPathNative"));
      return;
    }
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

  // Switching connection mode swaps in that mode's own saved codex
  // path/project history (see codexPathStorageKey etc. above) and re-checks
  // it, instead of leaving the other mode's WSL/Windows-shaped path behind.
  const modeSwitchedOnceRef = useRef(false);
  useEffect(() => {
    if (!modeSwitchedOnceRef.current) {
      modeSwitchedOnceRef.current = true; // skip the redundant run on mount
      return;
    }
    if (connectionMode === "native") {
      const storedPath = localStorage.getItem("codexPathNative") ?? "";
      const paths = loadStringList("projectPathsNative", []);
      setCodexPath(storedPath);
      setProjectPaths(paths);
      setProjectCwd(localStorage.getItem("projectCwdNative") ?? paths[0] ?? "");
      void resolveCodexPathNative(storedPath || null);
    } else {
      const storedPath = localStorage.getItem("codexPath") ?? DEFAULT_CODEX_PATH;
      const paths = loadStringList("projectPaths", [DEFAULT_PROJECT_PATH]);
      setCodexPath(storedPath);
      setProjectPaths(paths);
      setProjectCwd(localStorage.getItem("projectCwd") ?? paths[0] ?? "");
      void resolveCodexPath(distroRef.current, storedPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionMode]);

  const onConnectionModeChange = (mode: "wsl" | "native") => {
    setConnectionModeState(mode);
    localStorage.setItem("connectionMode", mode);
  };

  const onDistroChange = (name: string) => {
    setDistro(name);
    localStorage.setItem("distro", name);
    void resolveCodexPath(name, null);
  };

  // Manual codex-path entry: debounce, then verify the file actually exists
  // (and is executable) inside the selected distro (WSL mode) or on the
  // Windows filesystem (native mode) before enabling connect.
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
          const ok =
            connectionModeRef.current === "native"
              ? await invoke<boolean>("verify_codex_path_native", { path: value.trim() })
              : await invoke<boolean>("verify_codex_path", {
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

  // Refresh the usage badge *while* a turn runs, not only once it finishes.
  // The badge is otherwise fetched on connect, on turn/completed and when its
  // own panel is opened, so a long turn showed the pre-turn figure the whole
  // time and then jumped at the end -- exactly when watching the quota drain
  // is the point. Deliberately scoped to a running turn: nothing consumes
  // quota while idle, so polling then would be pure traffic. Ollama has no
  // rate-limit concept (its badge is hidden, and account/rateLimits/read is
  // not even called on connect there), so it is skipped.
  //
  // Declared after fetchUsage on purpose: naming it in a dependency array
  // above its own `const` would be read during render, i.e. in the temporal
  // dead zone.
  useEffect(() => {
    if (!activeTurnId || provider === "ollama") return;
    const interval = window.setInterval(() => void fetchUsage(), USAGE_POLL_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [activeTurnId, provider, fetchUsage]);

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
            turnStartTimeRef.current = Date.now();
            setLiveReasoning(null); // the pane belongs to one turn only
            stopFlashing(); // a previous turn's notice is stale once work resumes
            journalMarkStarted(p.threadId, p.turn.id);
            break;
          }
          case "turn/completed": {
            const p = parseOrReport(TurnCompletedNotificationSchema, params, "turn/completed", setErrorBanner);
            if (!p) break;
            setActiveTurnId(null);
            turnStartTimeRef.current = null;
            setLiveReasoning(null); // the transcript's reasoning item takes over
            if (p.turn.status === "failed") {
              setErrorBanner(`Turn failed: ${JSON.stringify((p.turn as unknown as TurnCompletedNotification["turn"]).error)}`);
            }
            journalMarkCompleted(p.threadId);
            notifyTurnEndIfIdle();
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
          // Reasoning summary streaming. Unlike agentMessage deltas these are
          // not merged into an item in `items` -- the item they belong to is
          // only added to the transcript once it completes, and until then the
          // temporary pane is the only place this text is visible.
          case "item/reasoning/summaryTextDelta": {
            const p = parseOrReport(
              ReasoningSummaryTextDeltaSchema,
              params,
              "item/reasoning/summaryTextDelta",
              setErrorBanner
            );
            if (!p) break;
            setLiveReasoning((prev) => appendSummaryDelta(prev, p));
            break;
          }
          case "item/reasoning/summaryPartAdded": {
            const p = parseOrReport(
              ReasoningSummaryPartAddedSchema,
              params,
              "item/reasoning/summaryPartAdded",
              setErrorBanner
            );
            if (!p) break;
            setLiveReasoning((prev) => startSummaryPart(prev, p));
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
        setStderrLog((prev) => [...prev.slice(-199), stripAnsi(ev.payload.line ?? "")]);
      })
    );

    unlisteners.push(
      listen<ConnectionTaggedEvent>("codex:disconnected", (ev) => {
        if (!isCurrent(ev.payload.connectionId)) return; // an already-replaced connection tearing down
        connectionIdRef.current = null;
        setConnState("disconnected");
        setActiveTurnId(null);
        setLiveReasoning(null);
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
    if (connectionMode === "wsl") localStorage.setItem("distro", distro);
    localStorage.setItem(codexPathStorageKey, codexPath);
    localStorage.setItem("provider", provider);
    localStorage.setItem("ollamaModel", ollamaModel);
    localStorage.setItem("ollamaContextWindow", ollamaContextWindow);
    const configOverrides: string[] =
      provider === "ollama"
        ? [
            "model_provider=ollama",
            ...(ollamaModel.trim() ? [`model=${ollamaModel.trim()}`] : []),
            ...(ollamaContextWindow.trim() ? [`model_context_window=${ollamaContextWindow.trim()}`] : []),
            // Ollama rejects "xhigh" outright ("invalid reasoning value"),
            // and ~/.codex/config.toml's model_reasoning_effort applies to
            // this session whenever the footer's level is 指定なし -- so a
            // config.toml written for OpenAI failed every Ollama turn before
            // any of it reached the model (reproduced with a bare
            // `codex exec -c model_provider=ollama` on 2026-08-02). Pin a
            // level Ollama accepts; picking one in the footer still wins,
            // since that travels per-turn on turn/start.
            `model_reasoning_effort=${OLLAMA_DEFAULT_EFFORT}`,
          ]
        : [];
    setConnState("connecting");
    setErrorBanner(null);
    try {
      const raw = await invoke("connect", { connectionMode, distro, codexPath, configOverrides });
      const info = parseOrReport(InitializeResponseSchema, raw, "initialize", setErrorBanner);
      if (!info) {
        setConnState("disconnected");
        return false;
      }
      connectionIdRef.current = info.connectionId ?? null;
      setInitInfo(info as InitializeResponse);
      setConnState("connected");
      setHasEverConnected(true);
      setThreadApprovalPolicies({});
      // A fresh app-server process may have loaded a config.toml that
      // changed since the last connection -- force the next picker open to
      // re-query rather than showing a stale server value.
      configSyncedRef.current = false;
      setEffortServerValue(null);
      setServiceTierServerValue(null);
      const codexVersion = parseCodexCliVersion(info.userAgent);
      if (
        codexVersion &&
        !isConfirmedCodexCliVersion(codexVersion) &&
        !acknowledgedCodexVersions.includes(codexVersion)
      ) {
        setUnconfirmedVersionModal(codexVersion);
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
      setThreadApprovalPolicies({});
      discardPastedImages();
      discardSentImages();
      setUsagePanel(null);
      setUsageModalOpen(false);
      setDefaultModelLabel(null);
      configSyncedRef.current = false;
      setEffortServerValue(null);
      setServiceTierServerValue(null);
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
    // approvalPolicy only takes effect the first time this app-server
    // process loads this particular thread (confirmed by live probe) --
    // re-opening a thread already loaded this connection silently keeps
    // whatever policy it loaded with. Once a thread has an entry here,
    // reuse that entry instead of the current dropdown value so a stale
    // send can't be mistaken for a real change (openThread already asked
    // the user before calling this, when the two differ).
    const effectivePolicy = threadApprovalPolicies[threadId] ?? approvalPolicy;
    try {
      const raw = await invoke("rpc_request", {
        method: "thread/resume",
        params: { threadId, approvalPolicy: effectivePolicy, sandbox: PROJECT_SANDBOX },
      });
      const res = parseOrReport(ThreadResumeResponseSchema, raw, "thread/resume", setErrorBanner);
      if (!res) return;
      setThreadApprovalPolicies((prev) => (threadId in prev ? prev : { ...prev, [threadId]: effectivePolicy }));
      const thread = res.thread as unknown as Thread;
      setActiveThreadId(thread.id);
      setActiveTurnId(latestInProgressTurnId(thread.turns));
      // A resumed turn's earlier reasoning deltas are gone (they were only
      // ever streamed); the pane refills from the next delta onwards.
      setLiveReasoning(null);
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
        localStorage.setItem(projectCwdStorageKey, cwd);
        setProjectPaths((prev) => {
          if (prev.includes(cwd)) return prev;
          const next = [...prev, cwd].sort();
          localStorage.setItem(projectPathsStorageKey, JSON.stringify(next));
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
    // Only ask when this connection has already loaded this thread under a
    // *different* level than what's currently selected -- reopening it under
    // the same level (or a thread never opened this connection) needs no
    // prompt since nothing would actually change either way.
    const appliedPolicy = threadApprovalPolicies[threadId];
    if (appliedPolicy !== undefined && appliedPolicy !== approvalPolicy) {
      setPendingPolicyReopen({ threadId, appliedPolicy });
      return;
    }
    if (connState !== "connected") {
      setPendingThreadId(threadId);
      return;
    }
    await resumeThread(threadId);
  };

  const confirmPolicyReopen = async () => {
    const threadId = pendingPolicyReopen?.threadId;
    setPendingPolicyReopen(null);
    if (!threadId) return;
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
        setLiveReasoning(null);
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
      setErrorBanner(
        connectionMode === "native" ? "プロジェクトのフォルダを選択してください" : "プロジェクトのWSLパスを選択してください"
      );
      return;
    }
    localStorage.setItem(projectCwdStorageKey, projectCwd);
    setErrorBanner(null);
    try {
      const raw = await invoke("rpc_request", {
        method: "thread/start",
        params: { cwd: projectCwd.trim(), approvalPolicy, sandbox: PROJECT_SANDBOX },
      });
      const res = parseOrReport(ThreadStartResponseSchema, raw, "thread/start", setErrorBanner);
      if (!res) return;
      setThreadApprovalPolicies((prev) => ({ ...prev, [res.thread.id]: approvalPolicy }));
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
      if (connectionMode === "native") {
        await invoke("open_native_terminal", { path: projectCwd });
      } else {
        await invoke("open_wsl_terminal", { distro, path: projectCwd });
      }
    } catch (e) {
      setErrorBanner(`ターミナルを開けませんでした: ${e}`);
    }
  };

  const openExplorerHere = async () => {
    try {
      if (connectionMode === "native") {
        await invoke("open_in_explorer_native", { path: projectCwd });
      } else {
        await invoke("open_in_explorer", { distro, path: projectCwd });
      }
    } catch (e) {
      setErrorBanner(`エクスプローラーを開けませんでした: ${e}`);
    }
  };

  // Native Explorer-style folder picker instead of the flat discovered-list
  // dropdown. In WSL mode, WSL is browsable from Windows via the
  // \\wsl.localhost\<distro> UNC form, so the dialog opens there and the
  // chosen path is converted back to a WSL path via windows_path_to_wsl
  // (also used by the drag-and-drop handler). In native mode the picked
  // path is already the path app-server itself needs, so it's used as-is.
  const browseForProject = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      if (connectionMode === "native") {
        const picked = await open({ directory: true, defaultPath: projectCwd || undefined });
        if (!picked || typeof picked !== "string") return;
        const next = projectPaths.includes(picked) ? projectPaths : [...projectPaths, picked].sort();
        setProjectPaths(next);
        localStorage.setItem(projectPathsStorageKey, JSON.stringify(next));
        setProjectCwd(picked);
        localStorage.setItem(projectCwdStorageKey, picked);
        return;
      }
      const startUnc = `\\\\wsl.localhost\\${distro}\\${(projectCwd || DEFAULT_PROJECT_PATH)
        .replace(/^\//, "")
        .replace(/\//g, "\\")}`;
      const picked = await open({ directory: true, defaultPath: startUnc });
      if (!picked || typeof picked !== "string") return;
      const wslPath = await invoke<string>("windows_path_to_wsl", { path: picked, distro });
      const next = projectPaths.includes(wslPath) ? projectPaths : [...projectPaths, wslPath].sort();
      setProjectPaths(next);
      localStorage.setItem(projectPathsStorageKey, JSON.stringify(next));
      setProjectCwd(wslPath);
      localStorage.setItem(projectCwdStorageKey, wslPath);
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
    localStorage.setItem("modelOverride", m.model);
    localStorage.setItem("modelOverrideLabel", m.displayName);
    applyForcedEffort(m.model);
    setModelPicker(null);
  };

  const clearModelOverride = () => {
    setModelOverride(null);
    setModelOverrideLabel(null);
    localStorage.removeItem("modelOverride");
    localStorage.removeItem("modelOverrideLabel");
  };

  // Pre-connect model entry: model/list needs a live app-server connection,
  // so there's no picker here -- just a free-text model id (same value
  // turn/start's `model` field takes), mirroring codexPath's own text-input
  // pattern. The display label is only ever properly resolved by the
  // post-connect 🧠 picker (which does have model/list's displayName), so
  // until then the raw id doubles as its own label.
  const onModelOverrideInput = (value: string) => {
    const trimmed = value.trim();
    setModelOverride(trimmed || null);
    setModelOverrideLabel(trimmed || null);
    if (trimmed) {
      localStorage.setItem("modelOverride", trimmed);
      localStorage.setItem("modelOverrideLabel", trimmed);
    } else {
      localStorage.removeItem("modelOverride");
      localStorage.removeItem("modelOverrideLabel");
    }
    applyForcedEffort(trimmed);
  };

  // Applied at selection time only (both the pre-connect field and the
  // post-connect 🧠 picker route through here), never on load: forcing it on
  // load would silently overwrite a level the user deliberately set for a
  // model they are already on.
  const applyForcedEffort = (modelId: string | null) => {
    const forced = forcedEffortForModel(modelId);
    if (forced && forced !== reasoningEffort) onReasoningEffortChange(forced);
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

  // Whole-transcript copy (the 📋 button above the transcript). Confirmation is
  // the button itself flipping to ✅ for a moment -- there is no dialog to show
  // (see scripts/check-no-native-dialogs.mjs) and a banner would be noisier
  // than the action deserves.
  const copyTranscript = async () => {
    const text = transcriptToText(items);
    if (!text) {
      setErrorBanner("コピーできる会話がありません");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedAll(true);
      window.setTimeout(() => setCopiedAll(false), 1500);
    } catch (e) {
      setErrorBanner(`クリップボードへのコピーに失敗しました: ${e}`);
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
            connectionMode: connectionModeRef.current,
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
          ...turnModelFields(provider, modelOverride, reasoningEffort, serviceTier),
          summary: REASONING_SUMMARY,
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

  // Shared between the minimal connect-only view (shown until this app
  // session has connected at least once, see hasEverConnected) and the
  // normal sidebar's own 接続 section -- same content either way.
  const connectSection = (
    <section>
      <h3>接続</h3>
      {connState === "connected" || connState === "disconnecting" ? (
        <button onClick={doDisconnect} disabled={connState === "disconnecting"}>
          {connState === "disconnecting" ? "切断中…" : "切断"}
        </button>
      ) : (
        <>
          <label>
            プロバイダ
            <select value={provider} onChange={(e) => setProvider(e.target.value as "openai" | "ollama")}>
              <option value="openai">OpenAI（既定）</option>
              <option value="ollama">Ollama（ローカル）</option>
            </select>
          </label>
          <label>
            接続方式
            <select value={connectionMode} onChange={(e) => onConnectionModeChange(e.target.value as "wsl" | "native")}>
              <option value="wsl">WSL内のcodex CLI</option>
              <option value="native">Windows側のcodex CLI</option>
            </select>
          </label>
          {connectionMode === "wsl" && (
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
          )}
          <label>
            {connectionMode === "native" ? "codex絶対パス（Windows）" : "codex絶対パス（WSL内）"}
            <input
              value={codexPath}
              onChange={(e) => onCodexPathInput(e.target.value)}
              placeholder={
                connectionMode === "native"
                  ? String.raw`C:\Users\user\AppData\Roaming\npm\codex.cmd`
                  : "/home/user/.nvm/.../bin/codex"
              }
            />
          </label>
          <div className="codex-path-status">
            {codexStatus === "checking" && <span className="checking">codexの場所を確認中…</span>}
            {codexStatus === "ok" && <span className="ok">✓ codexを確認しました</span>}
            {codexStatus === "ng" && <span className="ng">✗ {codexNotice ?? "codexが見つかりません"}</span>}
          </div>
          {provider !== "ollama" && (
            <>
              <label>
                モデル
                {modelCustomEntry ? (
                  <div className="project-path-row">
                    <input
                      value={modelOverride ?? ""}
                      onChange={(e) => onModelOverrideInput(e.target.value)}
                      placeholder={DEFAULT_MODEL_OVERRIDE}
                      title="turn/startのmodelとして毎ターン送信されます"
                    />
                    <button type="button" className="mini" onClick={() => setModelCustomEntry(false)} title="一覧から選ぶ">
                      一覧
                    </button>
                  </div>
                ) : (
                  <select
                    value={modelOverride ?? DEFAULT_MODEL_OVERRIDE}
                    onChange={(e) => {
                      if (e.target.value === "__custom__") {
                        setModelCustomEntry(true);
                        return;
                      }
                      onModelOverrideInput(e.target.value);
                    }}
                    title="turn/startのmodelとして毎ターン送信されます。接続後はフッターの🧠バッジから一覧を見て選べます（推論レベル・速度の対応状況もそちらで確認できます）。GPT-5.6-Lunaを選ぶと推論レベルは自動で「最大」に、Sol/Terraを選ぶと自動で「高い」になります（選択後に変更可）"
                  >
                    {!MODEL_PRESETS.some((m) => m.value === (modelOverride ?? DEFAULT_MODEL_OVERRIDE)) && (
                      <option value={modelOverride ?? DEFAULT_MODEL_OVERRIDE}>
                        {modelOverrideLabel ?? modelOverride}（未確認）
                      </option>
                    )}
                    {MODEL_PRESETS.map((m) => (
                      <option key={m.value} value={m.value}>
                        {m.label}
                      </option>
                    ))}
                    <option value="__custom__">その他（IDを直接入力）</option>
                  </select>
                )}
              </label>
              <label>
                推論レベル
                <select
                  value={reasoningEffort ?? ""}
                  onChange={(e) => onReasoningEffortChange(e.target.value)}
                  title="turn/startのeffortとして毎ターン送信されます。接続後もフッターのバッジからいつでも変更できます。GPT-5.6-Lunaを選ぶとここは自動で「最大」に、Sol/Terraを選ぶと自動で「高い」になります"
                >
                  <option value="">指定なし（サーバー側の設定に従う）</option>
                  {REASONING_EFFORTS.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                速度
                <select
                  value={serviceTier ?? ""}
                  onChange={(e) => onServiceTierChange(e.target.value)}
                  title="turn/startのserviceTierとして毎ターン送信されます。接続後もフッターのバッジからいつでも変更できます"
                >
                  <option value="">指定なし（サーバー側の設定に従う）</option>
                  {SERVICE_TIERS.map((s) => (
                    <option key={s.value} value={s.value}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {provider === "ollama" && (
            <>
              <label>
                Ollamaモデル
                <div className="project-path-row">
                  <select value={ollamaModel} onChange={(e) => onOllamaModelChange(e.target.value)}>
                    {ollamaModels.length === 0 && <option value={ollamaModel}>{ollamaModel}</option>}
                    {ollamaModels.length > 0 && !ollamaModels.some((m) => m.name === ollamaModel) && (
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
            title={codexStatus !== "ok" ? "codexの場所が確認できるまで接続できません" : undefined}
          >
            {connState === "connecting" ? "接続中…" : "接続"}
          </button>
        </>
      )}
    </section>
  );

  return (
    <div className="app">

      {/* Whole-window drop affordance: a drop is accepted wherever it lands, so
          the highlight covers the window instead of pointing at the composer. */}
      {dragOver && <div className="drag-overlay" />}

      {errorBanner && (
        <div className="banner" onClick={() => setErrorBanner(null)}>
          {errorBanner}
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          {!hasEverConnected ? (
            connectSection
          ) : (
            <>
          <section>
            <h3>プロジェクト</h3>
            <label>
              {connectionMode === "native" ? "フォルダ（参照で選んだフォルダの履歴）" : "WSLパス（参照で選んだフォルダの履歴）"}
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
                title={connectionMode === "native" ? "このフォルダでターミナルを開く" : "このWSLパスでターミナルを開く"}
              >
                ⌨
              </button>
              <button
                className="icon-btn"
                onClick={() => void openExplorerHere()}
                disabled={!projectCwd}
                title={connectionMode === "native" ? "このフォルダをエクスプローラーで開く" : "このWSLパスをエクスプローラーで開く"}
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
                        title={
                          t.id in threadApprovalPolicies
                            ? `${t.cwd}\n承認レベル: ${
                                APPROVAL_POLICIES.find((p) => p.value === threadApprovalPolicies[t.id])?.label ??
                                threadApprovalPolicies[t.id]
                              }（この接続内では変更できません）`
                            : t.cwd
                        }
                      >
                        {t.id in threadApprovalPolicies && <span className="policy-lock">🔒</span>}
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
                              setPendingArchive(t);
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

          {connectSection}
            </>
          )}
        </aside>

        {hasEverConnected && (
        <main className="chat">
          <button
            type="button"
            className="transcript-copy"
            title="この会話の全体をクリップボードにコピー"
            aria-label="会話全体をコピー"
            disabled={items.length === 0}
            onClick={() => void copyTranscript()}
          >
            {copiedAll ? "✅" : "📋"}
          </button>
          <div className={`transcript${activeTurnId ? " turn-active" : ""}`} ref={transcriptRef}>
            {items.map((di) => (
              <TranscriptItem
                key={di.key}
                di={di}
                distro={distro}
                cwd={projectCwd}
                connectionMode={connectionMode}
                onLinkError={setErrorBanner}
                onError={setErrorBanner}
              />
            ))}
            {activeTurnId && <div className="working">Codex is working…</div>}
          </div>
          {/* Temporary pane: exists only while the turn that produced this text
              is still running. Collapsed state persists, the text never does. */}
          {activeTurnId && liveReasoningShown && (
            <div className="live-reasoning">
              <div className="live-reasoning-head">
                <span>💭 推論経過（作業中）</span>
                <button
                  type="button"
                  className="mini"
                  onClick={() => {
                    const next = !liveReasoningOpen;
                    setLiveReasoningOpen(next);
                    localStorage.setItem("liveReasoningOpen", String(next));
                  }}
                >
                  {liveReasoningOpen ? "隠す" : "表示"}
                </button>
              </div>
              {liveReasoningOpen && (
                <div className="live-reasoning-body" ref={liveReasoningRef}>
                  {/* Summaries are markdown ("**Planning the fix**"), same as
                      the reasoning bubbles the transcript renders once the item
                      completes -- rendered as plain text the bold markers show
                      up as literal asterisks. Links go through MarkdownLink for
                      the same reason they do in the transcript. */}
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={markdownLinkComponents(distro, projectCwd, connectionMode, setErrorBanner)}
                  >
                    {liveReasoningShown}
                  </ReactMarkdown>
                </div>
              )}
            </div>
          )}
          <div className="composer-wrap">
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
        )}
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

      {effortPickerOpen && (
        <div className="modal-backdrop" onClick={() => setEffortPickerOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>推論レベルを選択</h3>
            <ul className="model-list">
              <li>
                <button
                  onClick={() => {
                    onReasoningEffortChange("");
                    setEffortPickerOpen(false);
                  }}
                >
                  <strong>指定なし（サーバー側の設定に従う）</strong>
                  {reasoningEffort === null && <span className="tag">選択中</span>}
                </button>
              </li>
              {REASONING_EFFORTS.map((r) => (
                <li key={r.value}>
                  <button
                    onClick={() => {
                      onReasoningEffortChange(r.value);
                      setEffortPickerOpen(false);
                    }}
                  >
                    <strong>{r.label}</strong>
                    {reasoningEffort === r.value && <span className="tag">選択中</span>}
                    {reasoningEffort === null && effortServerValue === r.value && (
                      <span className="tag secondary">現在のサーバー値</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <button className="mini" onClick={() => setEffortPickerOpen(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {speedPickerOpen && (
        <div className="modal-backdrop" onClick={() => setSpeedPickerOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>速度を選択</h3>
            <ul className="model-list">
              <li>
                <button
                  onClick={() => {
                    onServiceTierChange("");
                    setSpeedPickerOpen(false);
                  }}
                >
                  <strong>指定なし（サーバー側の設定に従う）</strong>
                  {serviceTier === null && <span className="tag">選択中</span>}
                </button>
              </li>
              {SERVICE_TIERS.map((s) => (
                <li key={s.value}>
                  <button
                    onClick={() => {
                      onServiceTierChange(s.value);
                      setSpeedPickerOpen(false);
                    }}
                  >
                    <strong>{s.label}</strong>
                    {serviceTier === s.value && <span className="tag">選択中</span>}
                    {serviceTier === null && serviceTierServerValue === s.value && (
                      <span className="tag secondary">現在のサーバー値</span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <button className="mini" onClick={() => setSpeedPickerOpen(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}

      {pendingPolicyReopen && (
        <div className="modal-backdrop" onClick={() => setPendingPolicyReopen(null)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <h3>以前の承認レベルのまま開きますか？</h3>
            <p>
              このスレッドはこの接続内で既に開かれており、承認レベルは「
              {APPROVAL_POLICIES.find((p) => p.value === pendingPolicyReopen.appliedPolicy)?.label ??
                pendingPolicyReopen.appliedPolicy}
              」のまま変更できません（一度切断して再接続すると次回は変更できます）。
            </p>
            <div className="decisions">
              <button className="primary" onClick={() => void confirmPolicyReopen()}>
                はい
              </button>
              <button className="danger" onClick={() => setPendingPolicyReopen(null)}>
                いいえ
              </button>
            </div>
          </div>
        </div>
      )}

      {pendingArchive && (
        <div className="modal-backdrop" onClick={() => setPendingArchive(null)}>
          <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
            <h3>アーカイブしますか？</h3>
            <p>「{pendingArchive.name ?? pendingArchive.preview ?? pendingArchive.id}」をアーカイブします。</p>
            <div className="decisions">
              <button
                className="primary"
                onClick={() => {
                  const t = pendingArchive;
                  setPendingArchive(null);
                  if (t) void archiveThread(t);
                }}
              >
                はい
              </button>
              <button className="danger" onClick={() => setPendingArchive(null)}>
                いいえ
              </button>
            </div>
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

      {unconfirmedVersionModal && (
        <div className="modal-backdrop" onClick={() => dismissVersionWarning(unconfirmedVersionModal)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>新しいCodex CLIバージョンです</h3>
            <p>
              接続したCodex CLIのバージョン（{unconfirmedVersionModal}）はこのGUIで動作確認済みではありません（確認済み:{" "}
              {CONFIRMED_CODEX_CLI_VERSIONS.join(", ")}、および過去にOKした他のバージョン）。接続自体は継続しますが、想定外の挙動が起きる可能性があります。
            </p>
            <p className="cwd">このバージョンでは次回以降表示しません。</p>
            <button className="mini" onClick={() => dismissVersionWarning(unconfirmedVersionModal)}>
              OK
            </button>
          </div>
        </div>
      )}

      {usageModalOpen && usagePanel && (
        <div className="modal-backdrop" onClick={() => setUsageModalOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>使用量</h3>
            <UsageWindow label="Primary" w={usagePanel.rateLimits.primary} />
            <UsageWindow label="Secondary" w={usagePanel.rateLimits.secondary} />
            <CreditBanner rateLimits={usagePanel.rateLimits} />
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

      {/* Only rendered while connected: the bar exists to describe a live
          session, so its own presence is the connection indicator and the
          separate dot + "Codex server connected (owned)" text it used to
          carry were saying the same thing twice. Disconnecting still shows
          "切断中…" on the sidebar's own button, so no state is lost here.

          Order is deliberate (what the current turn is spending, then the
          fixed environment it runs in): model, reasoning level, speed,
          quota, elapsed -- then WSL, CLI, thread. Stop keeps its
          margin-left:auto so it stays pinned right regardless. */}
      {connState === "connected" && (
        <footer className="statusbar">
          {provider === "ollama" ? (
            <span className="model-footer">🦙 {ollamaModel}</span>
          ) : (
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
          {/* Reasoning level / speed / quota are OpenAI-account concepts with
              no Ollama equivalent (see turnModelFields.ts), so they stay
              hidden there rather than showing an inert "指定なし". */}
          {provider !== "ollama" && (
            <>
              <button
                className="model-footer-badge"
                onClick={openEffortPicker}
                title="推論レベルを変更（次のメッセージから反映）"
              >
                🎚 {REASONING_EFFORTS.find((r) => r.value === reasoningEffort)?.label ?? "指定なし"}
              </button>
              <button
                className="model-footer-badge"
                onClick={openSpeedPicker}
                title="速度を変更（次のメッセージから反映）"
              >
                🚀 {SERVICE_TIERS.find((s) => s.value === serviceTier)?.label ?? "指定なし"}
              </button>
            </>
          )}
          {provider !== "ollama" && usagePanel && (
            <button className="usage-badge" onClick={() => void openUsagePanel()} title={usageResetTooltip(usagePanel)}>
              <UsagePill label="P" pct={usagePanel.rateLimits.primary?.usedPercent} />
              {usagePanel.rateLimits.secondary && (
                <UsagePill label="S" pct={usagePanel.rateLimits.secondary?.usedPercent} />
              )}
              <CreditPill rateLimits={usagePanel.rateLimits} />
            </button>
          )}
          {activeTurnId && <span title="ターン経過時間">⏱ {formatElapsed(elapsedTime)}</span>}
          <span>{connectionMode === "native" ? "Windows-native" : `WSL: ${distro}`}</span>
          {initInfo && <span>Codex CLI: {initInfo.userAgent.split("/")[1]?.split(" ")[0] || initInfo.userAgent}</span>}
          {activeThreadId && (
            <span title={activeThreadId}>Thread: {activeThreadId.slice(0, 19)}…</span>
          )}
          {activeTurnId && (
            <button className="stop" onClick={stop}>
              ■ Stop
            </button>
          )}
        </footer>
      )}
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

// Compact footer readout of the credit balance. Shown whenever the account
// has credits -- not only once the plan quota runs out, which was the old
// behaviour and meant the number first appeared at the moment it had already
// started being spent. The distinct "credit" colour is kept for exactly that
// moment ("now spending real money" is a different kind of alert than "quota
// low"), so the pill reads as neutral the rest of the time.
function CreditPill({ rateLimits }: { rateLimits: import("./types").RateLimitSnapshot }) {
  const badge = creditBadge(rateLimits);
  if (!badge) return null;
  return (
    <span
      className={`usage-pill ${badge.drawing ? "credit" : ""}`}
      title={badge.drawing ? "プラン枠を使い切り、購入クレジットから消費中" : "購入クレジット残高"}
    >
      💳 残{badge.balance}
    </span>
  );
}

function CreditBanner({ rateLimits }: { rateLimits: import("./types").RateLimitSnapshot }) {
  const badge = creditBadge(rateLimits);
  // The banner stays an alarm: it only appears once credits are actually
  // being drawn on, unlike the always-on pill above.
  if (!badge?.drawing) return null;
  return (
    <div className="credit-banner">
      💳 プラン枠を使い切り、購入クレジットから消費中です。残クレジット: {badge.balance}
    </div>
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

// Native-mode counterpart to resolveAbsoluteWslPath: cwd and hrefs are
// ordinary Windows paths, so joining uses backslashes and an already-rooted
// href (drive letter or UNC) is left as-is instead of treated relative.
function resolveAbsoluteWindowsPath(href: string, cwd: string): string {
  const normalized = href.replace(/^\.[\\/]/, "").replace(/\//g, "\\");
  if (/^[a-zA-Z]:\\/.test(normalized) || normalized.startsWith("\\\\")) {
    return normalized;
  }
  return `${cwd.replace(/[\\/]$/, "")}\\${normalized}`;
}

const isSchemeUrl = (href: string) => /^[a-z][a-z0-9+.-]*:/i.test(href);

// A bare <a href> inside markdown navigates the whole webview away from the
// SPA when clicked (Tauri doesn't intercept in-page link clicks) -- from the
// user's perspective the app just "resets", losing all in-memory state.
// Intercept it instead: absolute URLs open in the default browser/app;
// anything else is treated as a WSL-relative path (codex often links build
// artifacts this way) and opened via Explorer's \\wsl.localhost UNC form.
// Every link also gets a right-click menu (open, reveal the containing folder,
// copy the address); file links are resolved through splitLineSuffix first, so
// codex's `path:line` references open the file instead of failing on a
// filename that does not exist.
function MarkdownLink({
  href,
  children,
  distro,
  cwd,
  connectionMode,
  onLinkError,
  ...props
}: React.ComponentProps<"a"> & {
  distro: string;
  cwd: string;
  connectionMode: "wsl" | "native";
  onLinkError: (msg: string) => void;
}) {
  const [menuPos, setMenuPos] = useState<{ x: number; y: number } | null>(null);
  const isFileLink = !!href && !isSchemeUrl(href);
  const target = isFileLink ? splitLineSuffix(href!) : null;

  // The path without the line suffix, in whichever form this connection mode
  // speaks: Windows paths natively, WSL paths through the \\wsl.localhost UNC
  // share for anything Explorer has to touch.
  const absolutePath = () =>
    connectionMode === "native"
      ? resolveAbsoluteWindowsPath(target!.path, cwd)
      : resolveAbsoluteWslPath(target!.path, cwd);

  const openLink = () => {
    if (!href) return;
    void (async () => {
      try {
        if (!isFileLink) {
          const { openUrl } = await import("@tauri-apps/plugin-opener");
          await openUrl(href);
        } else {
          const { openPath } = await import("@tauri-apps/plugin-opener");
          await openPath(connectionMode === "native" ? absolutePath() : wslPathToUnc(absolutePath(), distro));
        }
      } catch (err) {
        onLinkError(`リンクを開けませんでした（${href}）: ${err}`);
      }
    })();
  };

  const copyAddress = () => {
    if (!href) return;
    const address = isFileLink ? formatLinkAddress(absolutePath(), target!.line) : href;
    void navigator.clipboard
      .writeText(address)
      .catch((err) => onLinkError(`リンクアドレスをコピーできませんでした（${href}）: ${err}`));
  };

  return (
    <>
      <a
        {...props}
        href={href}
        onClick={(e) => {
          e.preventDefault();
          openLink();
        }}
        onContextMenu={(e) => {
          if (!href) return;
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
                openLink();
              }}
            >
              {isFileLink ? "リンク先を開く" : "リンクを開く"}
            </button>
            {isFileLink && (
              <button
                onClick={() => {
                  setMenuPos(null);
                  void (async () => {
                    try {
                      if (connectionMode === "native") {
                        await invoke("reveal_in_explorer_native", { path: absolutePath() });
                      } else {
                        await invoke("reveal_in_explorer", { distro, path: absolutePath() });
                      }
                    } catch (err) {
                      onLinkError(`エクスプローラーで開けませんでした（${href}）: ${err}`);
                    }
                  })();
                }}
              >
                エクスプローラーでリンク先のフォルダを開く
              </button>
            )}
            <button
              onClick={() => {
                setMenuPos(null);
                copyAddress();
              }}
            >
              リンクアドレスをコピー
            </button>
          </div>
        </>
      )}
    </>
  );
}

function markdownLinkComponents(
  distro: string,
  cwd: string,
  connectionMode: "wsl" | "native",
  onLinkError: (msg: string) => void
) {
  return {
    a: (props: React.ComponentProps<"a">) => (
      <MarkdownLink {...props} distro={distro} cwd={cwd} connectionMode={connectionMode} onLinkError={onLinkError} />
    ),
  };
}

// Every message carries its own copy button, revealed on hover so it does not
// clutter the transcript: the 📋 above the transcript copies the whole
// conversation, this one copies just this message. What it copies is
// itemToText() -- the same serializer the whole-conversation copy uses -- so
// the two never disagree about what a message says.
function MessageBubble({
  className,
  copyText,
  onError,
  children,
}: {
  className: string;
  copyText: string;
  onError: (msg: string) => void;
  children: React.ReactNode;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`msg ${className}`}>
      {copyText && (
        <button
          type="button"
          className="msg-copy"
          title="このメッセージをコピー"
          aria-label="このメッセージをコピー"
          onClick={() => {
            void navigator.clipboard.writeText(copyText).then(
              () => {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1200);
              },
              (e) => onError(`クリップボードへのコピーに失敗しました: ${e}`)
            );
          }}
        >
          {copied ? "✅" : "📋"}
        </button>
      )}
      {children}
    </div>
  );
}

// Memoized: without this, every keystroke in the composer re-renders the
// entire App component, which re-renders every already-settled message
// (each running its own Markdown parse) even though nothing about them
// changed -- the dominant cause of visible IME input lag once a thread has
// more than a few messages.
const TranscriptItem = memo(function TranscriptItem({
  di,
  distro,
  cwd,
  connectionMode,
  onLinkError,
  onError,
}: {
  di: DisplayItem;
  distro: string;
  cwd: string;
  connectionMode: "wsl" | "native";
  onLinkError: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const { item, streamingText } = di;
  const mdComponents = markdownLinkComponents(distro, cwd, connectionMode, onLinkError);
  const copyText = itemToText(di);
  switch (item.type) {
    case "userMessage": {
      return (
        <MessageBubble className="user" copyText={copyText} onError={onError}>
          {copyText}
        </MessageBubble>
      );
    }
    case "agentMessage": {
      return (
        <MessageBubble className="agent md" copyText={copyText} onError={onError}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{copyText}</ReactMarkdown>
        </MessageBubble>
      );
    }
    case "reasoning": {
      if (!copyText) return null;
      return (
        <MessageBubble className="reasoning md" copyText={copyText} onError={onError}>
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={mdComponents}>{copyText}</ReactMarkdown>
        </MessageBubble>
      );
    }
    case "commandExecution": {
      const it = item as Extract<ThreadItem, { type: "commandExecution" }>;
      return (
        <MessageBubble className="command" copyText={copyText} onError={onError}>
          <code>$ {it.command}</code>
          {(it.aggregatedOutput || streamingText) && (
            <pre>{it.aggregatedOutput ?? streamingText}</pre>
          )}
          {it.exitCode !== null && it.exitCode !== undefined && (
            <span className={`exit ${it.exitCode === 0 ? "ok" : "err"}`}>exit {it.exitCode}</span>
          )}
        </MessageBubble>
      );
    }
    case "fileChange": {
      const it = item as Extract<ThreadItem, { type: "fileChange" }>;
      return (
        <MessageBubble className="filechange" copyText={copyText} onError={onError}>
          <strong>File changes ({it.status})</strong>
          <ul>
            {it.changes?.map((c, i) => (
              <li key={i}>{typeof c.path === "string" ? c.path : JSON.stringify(c)}</li>
            ))}
          </ul>
        </MessageBubble>
      );
    }
    default:
      return null; // unknown item kinds are silently skipped (N-10)
  }
});
