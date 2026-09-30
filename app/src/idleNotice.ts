// "The turn finished while you were away" notice.
//
// The window is flashed (requestUserAttention) when a turn completes and
// either the *desktop* has been idle -- no keyboard or mouse anywhere, per
// the Rust system_idle_millis command -- or this window simply isn't the
// focused one. Either way the user has no way to notice the transcript
// updating on their own. The flashing stops once this window is the one
// they've actually come back to, not merely at the first sign of input
// anywhere: someone who moves the mouse inside a different window that
// happens to be covering this one would otherwise see the taskbar stop
// flashing before they ever looked at it. Every decision is here so it can
// be tested without a desktop.

// How long the desktop must have been untouched for a finished turn to be
// worth interrupting for. Short enough that stepping away briefly still gets
// the notice, long enough that someone reading the screen with a still mouse
// is not the common case.
export const IDLE_NOTICE_THRESHOLD_MS = 5000;

// How often the idle counter (and this window's focus state) is re-read
// while the window is flashing.
export const IDLE_POLL_INTERVAL_MS = 500;

export function shouldNotifyOnTurnEnd(idleMs: number, thresholdMs = IDLE_NOTICE_THRESHOLD_MS): boolean {
  return idleMs >= thresholdMs;
}

// Whether a just-finished turn should flash the window at all: either the
// desktop has been idle long enough, or this specific window isn't the
// focused one (so even someone actively at the keyboard, in some other
// window, can't see the update land).
export function shouldFlashOnTurnEnd(
  idleMs: number,
  windowFocused: boolean,
  thresholdMs = IDLE_NOTICE_THRESHOLD_MS
): boolean {
  return !windowFocused || shouldNotifyOnTurnEnd(idleMs, thresholdMs);
}

// The idle counter only ever grows while the desktop is untouched, so any
// drop means input happened since the previous poll -- that is one signal
// that flashing might no longer be warranted.
export function inputDetected(previousIdleMs: number, currentIdleMs: number): boolean {
  return currentIdleMs < previousIdleMs;
}

// Whether an in-progress flash should stop at this poll. Input elsewhere
// only counts once this window actually has focus -- otherwise the user
// could be typing or clicking into a different window (one that's covering
// this one), and the flash would stop before they ever saw it. A focus
// transition itself is a form of input (a click or Alt-Tab), so requiring
// both `windowFocused` and a detected drop -- rather than tracking the
// transition separately -- still fires on the very next poll once the user
// actually brings this window forward.
export function shouldStopFlashing(
  windowFocused: boolean,
  previousIdleMs: number,
  currentIdleMs: number
): boolean {
  return windowFocused && inputDetected(previousIdleMs, currentIdleMs);
}
