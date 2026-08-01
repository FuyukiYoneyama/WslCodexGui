import type { ThreadItem } from "./types.ts";

// Plain-text rendering of the transcript, shared by the two copy buttons: the
// per-message one copies a single item's body (itemToText), the whole-
// conversation one prefixes each body with its heading (transcriptToText).
// Both mirror what TranscriptItem actually puts on screen -- including
// reasoning summaries, command output and file changes -- so that what lands on
// the clipboard is what the user is looking at, not just the messages.

export interface CopyableItem {
  item: ThreadItem;
  streamingText?: string;
}

// The heading a message gets in the whole-conversation copy. null means the
// item kind is not rendered at all (and so is not copied either, N-10).
export function itemHeading(item: ThreadItem): string | null {
  switch (item.type) {
    case "userMessage":
      return "## ユーザー";
    case "agentMessage":
      return "## Codex";
    case "reasoning":
      return "## 思考";
    case "commandExecution":
      return "## コマンド";
    case "fileChange":
      return `## ファイル変更（${(item as Extract<ThreadItem, { type: "fileChange" }>).status}）`;
    default:
      return null;
  }
}

// The message body on its own -- what the per-message copy button puts on the
// clipboard. Empty means there is nothing on screen worth copying.
export function itemToText({ item, streamingText }: CopyableItem): string {
  switch (item.type) {
    case "userMessage": {
      const it = item as Extract<ThreadItem, { type: "userMessage" }>;
      return it.content.map((c) => c.text ?? "").join("");
    }
    case "agentMessage": {
      const it = item as Extract<ThreadItem, { type: "agentMessage" }>;
      return it.text || streamingText || "";
    }
    case "reasoning": {
      const it = item as Extract<ThreadItem, { type: "reasoning" }>;
      return it.summary?.join("\n") ?? "";
    }
    case "commandExecution": {
      const it = item as Extract<ThreadItem, { type: "commandExecution" }>;
      const lines = [`$ ${it.command}`];
      const output = it.aggregatedOutput ?? streamingText ?? "";
      if (output) lines.push(output);
      if (it.exitCode !== null && it.exitCode !== undefined) lines.push(`exit ${it.exitCode}`);
      return lines.join("\n");
    }
    case "fileChange": {
      const it = item as Extract<ThreadItem, { type: "fileChange" }>;
      return (it.changes ?? []).map((c) => `- ${typeof c.path === "string" ? c.path : JSON.stringify(c)}`).join("\n");
    }
    default:
      return "";
  }
}

export function transcriptToText(items: CopyableItem[]): string {
  const blocks: string[] = [];
  for (const di of items) {
    const heading = itemHeading(di.item);
    if (heading === null) continue;
    const body = itemToText(di);
    // A file change with no paths still says something ("changes: completed"),
    // but an empty message or an empty reasoning summary is not on screen
    // either, so it contributes nothing here.
    if (!body && di.item.type !== "fileChange") continue;
    blocks.push(body ? `${heading}\n${body}` : heading);
  }
  return blocks.join("\n\n");
}
