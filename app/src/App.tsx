import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  AgentMessageDelta,
  ApprovalDecision,
  CommandApprovalParams,
  GetAccountRateLimitsResponse,
  InitializeResponse,
  ItemNotification,
  Model,
  Notification,
  ServerRequest,
  Thread,
  ThreadItem,
  ThreadTokenUsage,
  ThreadTokenUsageUpdated,
  TurnCompletedNotification,
} from "./types";
import "./App.css";

type ConnState = "disconnected" | "connecting" | "connected" | "disconnecting";

// ENV-01 (spec 4.3): last confirmed-working values on this machine. Used as
// the initial default only — still overridable and persisted per N-20/F-02a.
const DEFAULT_CODEX_PATH = "/home/user/.nvm/versions/node/v22.22.2/bin/codex";
const DEFAULT_PROJECT_PATH = "/home/user";
const ADD_NEW_VALUE = "__add_new__";

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
  const [codexPath, setCodexPath] = useState(
    () => localStorage.getItem("codexPath") ?? DEFAULT_CODEX_PATH
  );
  // F-02b: explore roots (registered, bounded scan). F-02a: the resulting
  // selectable list is these roots plus their discovered subdirectories —
  // never a free-text path, and never an unbounded recursive scan.
  const [projectRoots, setProjectRoots] = useState<string[]>(() =>
    loadStringList("projectRoots", [DEFAULT_PROJECT_PATH])
  );
  const [projectPaths, setProjectPaths] = useState<string[]>(() =>
    loadStringList("projectPaths", [DEFAULT_PROJECT_PATH])
  );
  const [projectCwd, setProjectCwd] = useState(
    () => localStorage.getItem("projectCwd") ?? loadStringList("projectPaths", [DEFAULT_PROJECT_PATH])[0]
  );
  const [discovering, setDiscovering] = useState(false);
  const [addingRoot, setAddingRoot] = useState(false);
  const [newRootInput, setNewRootInput] = useState("");

  const [connState, setConnState] = useState<ConnState>("disconnected");
  const [initInfo, setInitInfo] = useState<InitializeResponse | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null);
  const [activeTurnId, setActiveTurnId] = useState<string | null>(null);
  const [items, setItems] = useState<DisplayItem[]>([]);
  const [approvals, setApprovals] = useState<ServerRequest[]>([]);
  const [input, setInput] = useState("");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [stderrLog, setStderrLog] = useState<string[]>([]);

  // "/" command palette (composer autocomplete).
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const [modelPicker, setModelPicker] = useState<Model[] | null>(null);
  const [modelOverride, setModelOverride] = useState<string | null>(null);
  const [threadTokenUsage, setThreadTokenUsage] = useState<ThreadTokenUsage | null>(null);
  const [usagePanel, setUsagePanel] = useState<GetAccountRateLimitsResponse | null>(null);
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  const [pendingThreadId, setPendingThreadId] = useState<string | null>(null);

  // Refs mirroring state that event handlers need without re-subscribing.
  const activeThreadIdRef = useRef<string | null>(null);
  activeThreadIdRef.current = activeThreadId;

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
          if (!isOverComposer(p.position.x, p.position.y)) return;
          void (async () => {
            const wslPaths: string[] = [];
            for (const winPath of p.paths) {
              try {
                wslPaths.push(await invoke<string>("windows_path_to_wsl", { path: winPath }));
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
  }, []);

  const refreshThreads = useCallback(async () => {
    try {
      const res = (await invoke("rpc_request", {
        method: "thread/list",
        params: { limit: 30 },
      })) as { data: Thread[] };
      setThreads(res.data);
    } catch (e) {
      setErrorBanner(`thread/list failed: ${e}`);
    }
  }, []);

  // Silent refresh for the always-on footer badge (no error banner spam —
  // this runs automatically, not on explicit user action).
  const fetchUsage = useCallback(async () => {
    try {
      const res = await invoke<GetAccountRateLimitsResponse>("rpc_request", {
        method: "account/rateLimits/read",
        params: undefined,
      });
      setUsagePanel(res);
    } catch {
      // connection may be mid-teardown etc.; footer badge just stays stale
    }
  }, []);

  // F-02b: scan each registered root (bounded depth, no shell string
  // interpolation — see list_directories in Rust) and build the selectable
  // list from the roots themselves plus what was found under them. This
  // does not require an app-server connection; only wsl.exe.
  const discoverProjects = useCallback(
    async (roots: string[]) => {
      setDiscovering(true);
      try {
        const results = await Promise.allSettled(
          roots.map((root) =>
            invoke<string[]>("list_directories", { distro, root, maxDepth: 2 })
          )
        );
        const found = new Set<string>(roots);
        const failures: string[] = [];
        results.forEach((r, i) => {
          if (r.status === "fulfilled") {
            for (const d of r.value) found.add(d);
          } else {
            failures.push(`${roots[i]}: ${r.reason}`);
          }
        });
        const merged = [...found].sort();
        setProjectPaths(merged);
        localStorage.setItem("projectPaths", JSON.stringify(merged));
        if (!merged.includes(projectCwd) && merged.length > 0) {
          setProjectCwd(merged[0]);
          localStorage.setItem("projectCwd", merged[0]);
        }
        if (failures.length > 0) {
          console.warn("project discovery failed for some roots:", failures);
        }
      } finally {
        setDiscovering(false);
      }
    },
    [distro, projectCwd]
  );

  // Discover on mount and whenever the target distro changes.
  useEffect(() => {
    void discoverProjects(projectRoots);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [distro]);

  // --- event wiring ---
  useEffect(() => {
    const unlisteners: Promise<() => void>[] = [];

    unlisteners.push(
      listen<Notification>("codex:notification", (ev) => {
        const { method, params } = ev.payload;
        const threadId = (params as { threadId?: string } | undefined)?.threadId;
        if (threadId && threadId !== activeThreadIdRef.current) return;

        switch (method) {
          case "turn/started": {
            const p = params as { turn?: { id: string } };
            if (p.turn?.id) setActiveTurnId(p.turn.id);
            break;
          }
          case "turn/completed": {
            const p = params as unknown as TurnCompletedNotification;
            setActiveTurnId(null);
            if (p.turn.status === "failed") {
              setErrorBanner(`Turn failed: ${JSON.stringify(p.turn.error)}`);
            }
            void fetchUsage(); // keep the footer badge current after each turn
            break;
          }
          case "item/started": {
            const p = params as unknown as ItemNotification;
            setItems((prev) => [...prev, { key: p.item.id, item: p.item, streamingText: "" }]);
            break;
          }
          case "item/completed": {
            const p = params as unknown as ItemNotification;
            setItems((prev) => {
              const idx = prev.findIndex((di) => di.item.id === p.item.id);
              const done: DisplayItem = { key: p.item.id, item: p.item };
              if (idx < 0) return [...prev, done];
              const next = [...prev];
              next[idx] = done;
              return next;
            });
            break;
          }
          case "item/agentMessage/delta": {
            const p = params as unknown as AgentMessageDelta;
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
            const p = params as unknown as ThreadTokenUsageUpdated;
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
        setApprovals((prev) => [...prev, ev.payload]);
      })
    );

    unlisteners.push(
      listen<string>("codex:stderr", (ev) => {
        setStderrLog((prev) => [...prev.slice(-199), ev.payload]);
      })
    );

    unlisteners.push(
      listen("codex:disconnected", () => {
        setConnState("disconnected");
        setActiveTurnId(null);
        // Pending approvals died with the connection (spec 7.3: 失効).
        setApprovals([]);
      })
    );

    unlisteners.push(
      listen<string>("codex:contamination", (ev) => {
        setErrorBanner(`プロトコル外のstdout出力を検出: ${ev.payload.slice(0, 200)}`);
      })
    );

    return () => {
      for (const u of unlisteners) u.then((f) => f());
    };
  }, [scheduleFlush, fetchUsage]);

  // --- actions ---
  const doConnect = async (): Promise<boolean> => {
    if (!codexPath.trim()) {
      setErrorBanner(
        "WSL内のcodex実行ファイルの絶対パスを入力してください。WSLターミナルで `which codex` を実行すると確認できます（例: /home/user/.nvm/versions/node/v22.22.2/bin/codex）。灰色の文字は入力例であり、値は未入力です。"
      );
      return false;
    }
    localStorage.setItem("distro", distro);
    localStorage.setItem("codexPath", codexPath);
    setConnState("connecting");
    setErrorBanner(null);
    try {
      const info = (await invoke("connect", { distro, codexPath })) as InitializeResponse;
      setInitInfo(info);
      setConnState("connected");
      await refreshThreads();
      void fetchUsage();
      return true;
    } catch (e) {
      setConnState("disconnected");
      setErrorBanner(`接続失敗: ${e}`);
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
      setConnState("disconnected");
      setActiveThreadId(null);
      setActiveTurnId(null);
      setItems([]);
      setApprovals([]);
      setUsagePanel(null);
      setUsageModalOpen(false);
    }
  };

  const resumeThread = async (threadId: string) => {
    setErrorBanner(null);
    try {
      const res = (await invoke("rpc_request", {
        method: "thread/resume",
        params: { threadId },
      })) as { thread: Thread };
      setActiveThreadId(res.thread.id);
      setActiveTurnId(null);
      setThreadTokenUsage(null); // stale until the next tokenUsage/updated for this thread
      setItems(
        res.thread.turns.flatMap((t) =>
          t.items.map((item) => ({ key: `${t.id}:${item.id}`, item }))
        )
      );
      // Reflect this thread's own workspace in the project selector, adding
      // it to the list if it isn't a discovered/registered path yet.
      if (res.thread.cwd) {
        const cwd = res.thread.cwd;
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
      setErrorBanner(`thread/resume failed: ${e}`);
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
      const res = (await invoke("rpc_request", {
        method: "thread/start",
        params: { cwd: projectCwd.trim() },
      })) as { thread: Thread };
      setActiveThreadId(res.thread.id);
      setItems([]);
      setThreadTokenUsage(null);
      await refreshThreads();
    } catch (e) {
      setErrorBanner(`thread/start failed: ${e}`);
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

  const send = async () => {
    const text = input.trim();
    if (!text || !activeThreadId || activeTurnId) return;
    setInput("");
    setErrorBanner(null);
    try {
      // N-17: sends are serialized — input is disabled while a turn runs.
      await invoke("rpc_request", {
        method: "turn/start",
        params: {
          threadId: activeThreadId,
          input: [{ type: "text", text, text_elements: [] }],
          ...(modelOverride ? { model: modelOverride } : {}),
        },
      });
    } catch (e) {
      setErrorBanner(`turn/start failed: ${e}`);
    }
  };

  const stop = async () => {
    if (!activeThreadId || !activeTurnId) return;
    try {
      // F-06: Stop cancels the running turn only; never kills the process.
      await invoke("rpc_request", {
        method: "turn/interrupt",
        params: { threadId: activeThreadId, turnId: activeTurnId },
      });
    } catch (e) {
      setErrorBanner(`turn/interrupt failed: ${e}`);
    }
  };

  const answerApproval = async (req: ServerRequest, decision: ApprovalDecision) => {
    try {
      await invoke("respond_server_request", {
        id: req.id,
        result: { decision },
      });
    } catch (e) {
      setErrorBanner(`承認応答の送信に失敗: ${e}`);
    } finally {
      // Never answer the same request id twice (spec 7.3).
      setApprovals((prev) => prev.filter((a) => a.id !== req.id));
    }
  };

  const openModelPicker = async () => {
    try {
      const res = await invoke<{ data: Model[] }>("rpc_request", {
        method: "model/list",
        params: {},
      });
      setModelPicker(res.data.filter((m) => !m.hidden));
    } catch (e) {
      setErrorBanner(`model/list failed: ${e}`);
    }
  };

  const pickModel = (m: Model) => {
    setModelOverride(m.model);
    setModelPicker(null);
  };

  // Silent refresh for the always-on footer badge (no error banner spam —
  // this runs automatically, not on explicit user action).
  const openUsagePanel = async () => {
    await fetchUsage();
    setUsageModalOpen(true);
  };

  // "/" command palette. Runs a local GUI action; nothing here is text sent
  // to the model. Selecting /model opens a second-level list (modelPicker)
  // instead of executing immediately.
  const slashCommands: { name: string; description: string; run: () => void }[] = [
    {
      name: "new",
      description: "選択中のプロジェクトで新しいスレッドを作成",
      run: () => void newThread(),
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
        }).catch((e) => setErrorBanner(`thread/compact/start failed: ${e}`));
      },
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

  const runSlashCommand = (cmd: { run: () => void }) => {
    cmd.run();
    setInput("");
    setSlashOpen(false);
    setSlashIndex(0);
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

  // F-02a: the dropdown lists roots + their discovered subdirectories.
  // "+ 探索ルートを追加…" registers a NEW ROOT to scan (F-02b) — it does not
  // set the project path directly, since the user asked to pick from an
  // actual discovered list rather than typing an exact path by hand.
  const onProjectSelectChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    if (e.target.value === ADD_NEW_VALUE) {
      setAddingRoot(true);
      setNewRootInput("");
      return;
    }
    setProjectCwd(e.target.value);
    localStorage.setItem("projectCwd", e.target.value);
  };

  const confirmNewRoot = async () => {
    const root = newRootInput.trim();
    setAddingRoot(false);
    if (!root) return;
    const nextRoots = projectRoots.includes(root) ? projectRoots : [...projectRoots, root];
    setProjectRoots(nextRoots);
    localStorage.setItem("projectRoots", JSON.stringify(nextRoots));
    await discoverProjects(nextRoots);
  };

  const approval = approvals[0];
  const approvalParams = (approval?.params ?? {}) as CommandApprovalParams;
  const decisions: ApprovalDecision[] =
    approvalParams.availableDecisions ?? ["accept", "decline", "cancel"];

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
            <h3>接続</h3>
            {connState === "connected" || connState === "disconnecting" ? (
              <button onClick={doDisconnect} disabled={connState === "disconnecting"}>
                {connState === "disconnecting" ? "切断中…" : "切断"}
              </button>
            ) : (
              <>
                <label>
                  WSLディストリ
                  <input value={distro} onChange={(e) => setDistro(e.target.value)} />
                </label>
                <label>
                  codex絶対パス（WSL内）
                  <input
                    value={codexPath}
                    onChange={(e) => setCodexPath(e.target.value)}
                    placeholder="/home/user/.nvm/.../bin/codex"
                  />
                </label>
                <button onClick={doConnect} disabled={connState === "connecting"}>
                  {connState === "connecting" ? "接続中…" : "接続"}
                </button>
              </>
            )}
          </section>

          <section>
            <h3>
              プロジェクト
              <button
                className="mini"
                onClick={() => discoverProjects(projectRoots)}
                disabled={discovering}
                title="探索ルート配下を再スキャン"
              >
                {discovering ? "…" : "↻"}
              </button>
            </h3>
            <label>
              WSLパス（探索ルート配下から選択）
              {addingRoot ? (
                <div className="add-path-row">
                  <input
                    autoFocus
                    value={newRootInput}
                    onChange={(e) => setNewRootInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        void confirmNewRoot();
                      } else if (e.key === "Escape") {
                        setAddingRoot(false);
                      }
                    }}
                    placeholder="/home/user/work"
                  />
                  <button className="mini" onClick={() => void confirmNewRoot()}>
                    OK
                  </button>
                  <button className="mini" onClick={() => setAddingRoot(false)}>
                    ×
                  </button>
                </div>
              ) : (
                <select value={projectCwd} onChange={onProjectSelectChange}>
                  {projectPaths.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                  <option value={ADD_NEW_VALUE}>+ 探索ルートを追加…</option>
                </select>
              )}
            </label>
            <div className="project-actions">
              <button onClick={newThread} disabled={connState !== "connected" || addingRoot}>
                新しいスレッド
              </button>
              <button
                className="icon-btn"
                onClick={() => void openTerminalHere()}
                disabled={!projectCwd || addingRoot}
                title="このWSLパスでターミナルを開く"
              >
                ⌨
              </button>
              <button
                className="icon-btn"
                onClick={() => void openExplorerHere()}
                disabled={!projectCwd || addingRoot}
                title="このWSLパスをエクスプローラーで開く"
              >
                📁
              </button>
            </div>
          </section>

          <section className="threads">
            <h3>
              スレッド
              <button className="mini" onClick={refreshThreads} disabled={connState !== "connected"}>
                ↻
              </button>
            </h3>
            <ul>
              {threads.map((t) => (
                <li key={t.id}>
                  <button
                    className={t.id === activeThreadId ? "active" : ""}
                    onClick={() => openThread(t.id)}
                    title={t.cwd}
                  >
                    {(t.name ?? t.preview ?? t.id).slice(0, 40) || "(empty)"}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        <main className="chat">
          <div className="transcript" ref={transcriptRef}>
            {items.map((di) => (
              <TranscriptItem key={di.key} di={di} />
            ))}
            {activeTurnId && <div className="working">Codex is working…</div>}
          </div>
          <div className={`composer-wrap${dragOver ? " drag-over" : ""}`} ref={composerWrapRef}>
            {modelOverride && (
              <div className="model-badge">
                Model: {modelOverride}
                <button className="mini" onClick={() => setModelOverride(null)}>
                  ×
                </button>
              </div>
            )}
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
            <div className="composer">
              <textarea
                value={input}
                onChange={onInputChange}
                onKeyDown={onInputKeyDown}
                placeholder={
                  activeThreadId
                    ? "メッセージを入力（Enterで送信 / Shift+Enterで改行 / \"/\"でコマンド）"
                    : "先にスレッドを選択または作成してください"
                }
                disabled={connState !== "connected" || !activeThreadId || !!activeTurnId}
                rows={3}
              />
              <button onClick={send} disabled={!input.trim() || !activeThreadId || !!activeTurnId}>
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
            <div className="decisions">
              {decisions.map((d, i) => (
                <button
                  key={i}
                  className={typeof d === "string" && (d === "cancel" || d === "decline") ? "danger" : "primary"}
                  onClick={() => answerApproval(approval, d)}
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

      {stderrLog.length > 0 && (
        <details className="stderr">
          <summary>サーバー診断ログ ({stderrLog.length})</summary>
          <pre>{stderrLog.join("\n")}</pre>
        </details>
      )}

      <footer className="statusbar">
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
        {usagePanel && (
          <button className="usage-badge" onClick={() => void openUsagePanel()} title="使用量の詳細を表示">
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

function TranscriptItem({ di }: { di: DisplayItem }) {
  const { item, streamingText } = di;
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
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
        </div>
      );
    }
    case "reasoning": {
      const it = item as Extract<ThreadItem, { type: "reasoning" }>;
      const summary = it.summary?.join("\n") ?? "";
      if (!summary) return null;
      return (
        <div className="msg reasoning md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{summary}</ReactMarkdown>
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
