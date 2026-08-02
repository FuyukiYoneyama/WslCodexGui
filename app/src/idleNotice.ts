// "The turn finished while you were away" notice.
//
// The window is flashed (requestUserAttention) when a turn completes and the
// *desktop* has been idle -- no keyboard or mouse anywhere, per the Rust
// system_idle_millis command -- and the flashing stops as soon as the user
// touches the machine again. Both decisions are here so they can be tested
// without a desktop.

// How long the desktop must have been untouched for a finished turn to be
// worth interrupting for. Short enough that stepping away briefly still gets
// the notice, long enough that someone reading the screen with a still mouse
// is not the common case.
export const IDLE_NOTICE_THRESHOLD_MS = 5000;

// How often the idle counter is re-read while the window is flashing.
export const IDLE_POLL_INTERVAL_MS = 500;

export function shouldNotifyOnTurnEnd(idleMs: number, thresholdMs = IDLE_NOTICE_THRESHOLD_MS): boolean {
  return idleMs >= thresholdMs;
}

// The idle counter only ever grows while the desktop is untouched, so any
// drop means input happened since the previous poll -- that is the signal to
// stop flashing. Comparing against the previous reading (rather than testing
// for a small absolute value) keeps this correct no matter how slow or
// jittery the polling turns out to be.
export function inputDetected(previousIdleMs: number, currentIdleMs: number): boolean {
  return currentIdleMs < previousIdleMs;
}
