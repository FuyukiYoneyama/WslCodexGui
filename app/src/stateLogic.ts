import type { Turn } from "./types.ts";

export interface ImageContext {
  connectionId: string;
  distro: string;
  threadId: string;
}

export function sameImageContext(a: ImageContext, b: ImageContext): boolean {
  return a.connectionId === b.connectionId && a.distro === b.distro && a.threadId === b.threadId;
}

export function latestInProgressTurnId(turns: Pick<Turn, "id" | "status">[]): string | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    if (turns[i].status === "inProgress") return turns[i].id;
  }
  return null;
}

export function turnIsTerminal(status: Turn["status"]): boolean {
  return status !== "inProgress";
}
