import type { ThreadItem } from "./types.ts";

// Plain-text rendering of the transcript for the "copy the whole conversation"
// button. It mirrors what TranscriptItem actually puts on screen -- including
// reasoning summaries, command output and file changes -- so that what lands on
// the clipboard is what the user is looking at, not just the messages.

export interface CopyableItem {
  item: ThreadItem;
  streamingText?: string;
}

export function transcriptToText(items: CopyableItem[]): string {
  const blocks: string[] = [];
  for (const { item, streamingText } of items) {
    switch (item.type) {
      case "userMessage": {
        const it = item as Extract<ThreadItem, { type: "userMessage" }>;
        const text = it.content.map((c) => c.text ?? "").join("");
        if (text) blocks.push(`## ユーザー\n${text}`);
        break;
      }
      case "agentMessage": {
        const it = item as Extract<ThreadItem, { type: "agentMessage" }>;
        const text = it.text || streamingText || "";
        if (text) blocks.push(`## Codex\n${text}`);
        break;
      }
      case "reasoning": {
        const it = item as Extract<ThreadItem, { type: "reasoning" }>;
        const summary = it.summary?.join("\n") ?? "";
        if (summary) blocks.push(`## 思考\n${summary}`);
        break;
      }
      case "commandExecution": {
        const it = item as Extract<ThreadItem, { type: "commandExecution" }>;
        const lines = [`## コマンド`, `$ ${it.command}`];
        const output = it.aggregatedOutput ?? streamingText ?? "";
        if (output) lines.push(output);
        if (it.exitCode !== null && it.exitCode !== undefined) lines.push(`exit ${it.exitCode}`);
        blocks.push(lines.join("\n"));
        break;
      }
      case "fileChange": {
        const it = item as Extract<ThreadItem, { type: "fileChange" }>;
        const paths = (it.changes ?? []).map((c) => `- ${typeof c.path === "string" ? c.path : JSON.stringify(c)}`);
        blocks.push([`## ファイル変更（${it.status}）`, ...paths].join("\n"));
        break;
      }
      default:
        break; // unknown item kinds are skipped here for the same reason they are not rendered (N-10)
    }
  }
  return blocks.join("\n\n");
}
