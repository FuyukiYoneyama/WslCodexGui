// Self-heal for "Japanese IME composes outside the app window".
//
// Symptom (seen on real hardware, 2026-10-07 and earlier at 0.5.21/0.5.26):
// with the composer focused, typing romaji shows the OS-level candidate window
// at the desktop's top-left corner and nothing appears inline in the textarea.
// The page never receives the composition at all -- the IME is not attached to
// the WebView2 text input (a known, intermittent WebView2 TSF bug; see
// app/README.md "起動直後だけIMEのON/OFFがおかしい"). It could not be reproduced
// on demand (fresh launch, returning from another window, big threads, taskbar
// flashing on/off were all healthy), so instead of guessing at a trigger this
// detects the failure itself and applies the cure that is known to work: move
// focus away and back, which makes the IME re-attach.
//
// Signature. With the IME on, a letter key arrives as keydown with keyCode 229
// ("Process"). When the IME is attached, `compositionstart` follows within
// milliseconds. When it is not, it never comes. Only letter keys are used:
// space/digits/punctuation can be committed by the IME without any composition
// and would look like a failure when they are not.

// Far longer than a healthy keydown -> compositionstart gap (a few ms), short
// enough that the user sees at most one stray keystroke before it heals.
export const IME_ANCHOR_TIMEOUT_MS = 400;

// After a heal attempt, leave the field alone for a while. If the cure did not
// take, re-running it on every keystroke would only make things worse.
export const IME_HEAL_COOLDOWN_MS = 3000;

export interface KeyInfo {
  keyCode: number;
  code: string;
  isComposing: boolean;
}

// True for the keydown that should be followed by a compositionstart.
export function startsComposition(e: KeyInfo): boolean {
  return e.keyCode === 229 && !e.isComposing && /^Key[A-Z]$/.test(e.code);
}

type Timer = ReturnType<typeof setTimeout>;

export interface ImeAnchorWatchOptions {
  heal: () => void;
  timeoutMs?: number;
  cooldownMs?: number;
  // Injectable for tests.
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => Timer;
  clearTimer?: (t: Timer) => void;
}

export class ImeAnchorWatch {
  private heal: () => void;
  private timeoutMs: number;
  private cooldownMs: number;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => Timer;
  private clearTimer: (t: Timer) => void;
  private timer: Timer | null = null;
  private composing = false;
  private lastHealAt = -Infinity;

  constructor(options: ImeAnchorWatchOptions) {
    this.heal = options.heal;
    this.timeoutMs = options.timeoutMs ?? IME_ANCHOR_TIMEOUT_MS;
    this.cooldownMs = options.cooldownMs ?? IME_HEAL_COOLDOWN_MS;
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((t) => clearTimeout(t));
  }

  keyDown(e: KeyInfo): void {
    if (this.composing || this.timer !== null) return;
    if (!startsComposition(e)) return;
    if (this.now() - this.lastHealAt < this.cooldownMs) return;
    this.timer = this.setTimer(() => {
      this.timer = null;
      // compositionstart may have landed in the meantime (handled below), but
      // check again: healing a composition that did attach would break it.
      if (this.composing) return;
      this.lastHealAt = this.now();
      this.heal();
    }, this.timeoutMs);
  }

  compositionStart(): void {
    this.composing = true;
    this.cancelPending();
  }

  compositionEnd(): void {
    this.composing = false;
  }

  dispose(): void {
    this.cancelPending();
  }

  private cancelPending(): void {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}
