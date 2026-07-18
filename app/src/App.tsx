import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  AgentMessageDelta,
  ApprovalDecision,
  CommandApprovalParams,
  InitializeResponse,
  ItemNotification,
  Notification,
  ServerRequest,
  Thread,
  ThreadItem,
  TurnCompletedNotification,
} from "./types";
import "./App.css";

type ConnState = "disconnected" | "connecting" | "connected";

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
  const [codexPath, setCodexPath] = useState(() => localStorage.getItem("codexPath") ?? "");
  const [projectCwd, setProjectCwd] = useState(() => localStorage.getItem("projectCwd") ?? "");

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
  }, [scheduleFlush]);

  // --- actions ---
  const doConnect = async () => {
    localStorage.setItem("distro", distro);
    localStorage.setItem("codexPath", codexPath);
    setConnState("connecting");
    setErrorBanner(null);
    try {
      const info = (await invoke("connect", { distro, codexPath })) as InitializeResponse;
      setInitInfo(info);
      setConnState("connected");
      await refreshThreads();
    } catch (e) {
      setConnState("disconnected");
      setErrorBanner(`接続失敗: ${e}`);
    }
  };

  const doDisconnect = async () => {
    await invoke("disconnect");
    setConnState("disconnected");
    setActiveThreadId(null);
    setActiveTurnId(null);
    setItems([]);
    setApprovals([]);
  };

  const openThread = async (threadId: string) => {
    setErrorBanner(null);
    try {
      const res = (await invoke("rpc_request", {
        method: "thread/resume",
        params: { threadId },
      })) as { thread: Thread };
      setActiveThreadId(res.thread.id);
      setActiveTurnId(null);
      setItems(
        res.thread.turns.flatMap((t) =>
          t.items.map((item) => ({ key: `${t.id}:${item.id}`, item }))
        )
      );
    } catch (e) {
      setErrorBanner(`thread/resume failed: ${e}`);
    }
  };

  const newThread = async () => {
    if (!projectCwd.trim()) {
      setErrorBanner("プロジェクトのWSLパスを入力してください（例: /home/user/src/myapp）");
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
      await refreshThreads();
    } catch (e) {
      setErrorBanner(`thread/start failed: ${e}`);
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

  // N-05: never send while IME composition is active.
  const onInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };

  const approval = approvals[0];
  const approvalParams = (approval?.params ?? {}) as CommandApprovalParams;
  const decisions: ApprovalDecision[] =
    approvalParams.availableDecisions ?? ["accept", "decline", "cancel"];

  return (
    <div className="app">
      <header className="statusbar">
        <span className={`dot ${connState}`} />
        <span>{connState === "connected" ? "Codex server connected (owned)" : connState}</span>
        <span>WSL: {distro}</span>
        {initInfo && <span>{initInfo.userAgent.split(" ")[0]}</span>}
        {activeThreadId && <span>Thread: {activeThreadId.slice(0, 13)}…</span>}
        {activeTurnId && (
          <button className="stop" onClick={stop}>
            ■ Stop
          </button>
        )}
      </header>

      {errorBanner && (
        <div className="banner" onClick={() => setErrorBanner(null)}>
          {errorBanner}
        </div>
      )}

      <div className="body">
        <aside className="sidebar">
          <section>
            <h3>接続</h3>
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
            {connState === "connected" ? (
              <button onClick={doDisconnect}>切断</button>
            ) : (
              <button onClick={doConnect} disabled={connState === "connecting" || !codexPath.trim()}>
                {connState === "connecting" ? "接続中…" : "接続"}
              </button>
            )}
          </section>

          <section>
            <h3>プロジェクト</h3>
            <label>
              WSLパス
              <input
                value={projectCwd}
                onChange={(e) => setProjectCwd(e.target.value)}
                placeholder="/home/user/src/myapp"
              />
            </label>
            <button onClick={newThread} disabled={connState !== "connected"}>
              新しいスレッド
            </button>
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
          <div className="composer">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onInputKeyDown}
              placeholder={
                activeThreadId
                  ? "メッセージを入力（Enterで送信 / Shift+Enterで改行）"
                  : "先にスレッドを選択または作成してください"
              }
              disabled={connState !== "connected" || !activeThreadId || !!activeTurnId}
              rows={3}
            />
            <button onClick={send} disabled={!input.trim() || !activeThreadId || !!activeTurnId}>
              送信
            </button>
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

      {stderrLog.length > 0 && (
        <details className="stderr">
          <summary>サーバー診断ログ ({stderrLog.length})</summary>
          <pre>{stderrLog.join("\n")}</pre>
        </details>
      )}
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
      return <div className="msg agent">{it.text || streamingText || ""}</div>;
    }
    case "reasoning": {
      const it = item as Extract<ThreadItem, { type: "reasoning" }>;
      const summary = it.summary?.join("\n") ?? "";
      if (!summary) return null;
      return <div className="msg reasoning">{summary}</div>;
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
