// External store for actively-streaming item text, deliberately outside
// React state. Routing every ~33ms delta flush through `setItems` (an array
// that reaches ~20,000 DisplayItems on real threads) recreated the whole
// array on every tick, which invalidated the transcript's memoized render
// and forced React to reconcile all ~20,000 rows at up to 30Hz during heavy
// streaming -- reproduced live as a full UI freeze (no button, including
// 切断, responded) on a large thread with active output. Subscribing per
// item id via `useSyncExternalStore` means only the one component currently
// rendering that item re-renders on a flush; the parent array's identity
// never has to change for streaming text at all.
import { useSyncExternalStore } from "react";

const buffers = new Map<string, string>();
const listeners = new Map<string, Set<() => void>>();

function notify(itemId: string) {
  listeners.get(itemId)?.forEach((l) => l());
}

export function getStreamingText(itemId: string): string | undefined {
  return buffers.get(itemId);
}

export function appendStreamingText(itemId: string, add: string): void {
  buffers.set(itemId, (buffers.get(itemId) ?? "") + add);
  notify(itemId);
}

// Called once an item completes (its final text/aggregatedOutput is now
// authoritative) so a delta that was still in flight when item/completed
// arrived can't resurrect a stale streamingText on an already-finished item.
export function clearStreamingText(itemId: string): void {
  if (!buffers.has(itemId)) return;
  buffers.delete(itemId);
  notify(itemId);
}

function subscribe(itemId: string, onChange: () => void): () => void {
  let set = listeners.get(itemId);
  if (!set) {
    set = new Set();
    listeners.set(itemId, set);
  }
  set.add(onChange);
  return () => {
    set!.delete(onChange);
    if (set!.size === 0) listeners.delete(itemId);
  };
}

export function useStreamingText(itemId: string): string | undefined {
  return useSyncExternalStore(
    (onChange) => subscribe(itemId, onChange),
    () => getStreamingText(itemId)
  );
}
