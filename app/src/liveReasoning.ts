// Buffer behind the temporary "推論経過" pane shown while a turn runs.
//
// app-server streams the reasoning summary as `item/reasoning/summaryTextDelta`
// (append to the paragraph at `summaryIndex`) and `summaryPartAdded` (a new
// paragraph begins). The finished text lands in the transcript as a normal
// reasoning item once the item completes, so this buffer is deliberately
// throwaway: it is scoped to one turn and dropped when that turn ends. Keying
// on turnId means a late delta from the previous turn cannot bleed into the
// next one's pane.
//
// A turn produces *several* reasoning items, and `summaryIndex` restarts at 0
// for each one (verified against a live app-server on 2026-08-02), so a
// paragraph is identified by itemId *and* summaryIndex -- keying on the index
// alone ran consecutive items' summaries together into one paragraph.

export interface ReasoningPart {
  itemId: string;
  index: number;
  text: string;
}

export interface LiveReasoning {
  turnId: string;
  // Arrival order, which is the order the model produced them in.
  parts: ReasoningPart[];
}

function withPart(
  state: LiveReasoning | null,
  event: { turnId: string; itemId: string; summaryIndex: number }
): LiveReasoning {
  const base = state && state.turnId === event.turnId ? state.parts : [];
  const exists = base.some((p) => p.itemId === event.itemId && p.index === event.summaryIndex);
  const parts = exists
    ? base.slice()
    : [...base, { itemId: event.itemId, index: event.summaryIndex, text: "" }];
  return { turnId: event.turnId, parts };
}

export function appendSummaryDelta(
  state: LiveReasoning | null,
  event: { turnId: string; itemId: string; summaryIndex: number; delta: string }
): LiveReasoning {
  const next = withPart(state, event);
  next.parts = next.parts.map((p) =>
    p.itemId === event.itemId && p.index === event.summaryIndex ? { ...p, text: p.text + event.delta } : p
  );
  return next;
}

export function startSummaryPart(
  state: LiveReasoning | null,
  event: { turnId: string; itemId: string; summaryIndex: number }
): LiveReasoning {
  return withPart(state, event);
}

// The pane's text. Empty parts are dropped so an announced-but-still-empty
// paragraph does not show up as a blank gap.
export function liveReasoningText(state: LiveReasoning | null): string {
  if (!state) return "";
  return state.parts
    .map((p) => p.text)
    .filter((t) => t !== "")
    .join("\n\n");
}
