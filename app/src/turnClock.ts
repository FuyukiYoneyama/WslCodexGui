// Turn duration with the approval wait taken out.
//
// The footer timer answers "how long has this been working", and an approval
// dialog is precisely the state where it is not: codex has stopped and is
// waiting on a person. Counting that as work time makes the figure say
// something untrue -- step away for ten minutes with a dialog open and the
// turn appears to have taken ten minutes longer than it did.
//
// Pausing is modelled by moving the start forward by however long the wait
// lasted, so elapsed stays a plain `now - start` everywhere else and there is
// no second accumulator to keep in sync. Multiple pauses in one turn (several
// approvals) accumulate naturally, since each resume shifts the start again.

export interface TurnClock {
  /** Wall-clock ms when the turn began, already shifted by past pauses. */
  start: number;
  /** Wall-clock ms the current pause began, or null when running. */
  pausedAt: number | null;
}

export function startClock(now: number): TurnClock {
  return { start: now, pausedAt: null };
}

/** Idempotent: a second approval arriving while one is open must not restart the pause. */
export function pauseClock(clock: TurnClock, now: number): TurnClock {
  if (clock.pausedAt !== null) return clock;
  return { ...clock, pausedAt: now };
}

/** Idempotent: resuming when not paused leaves the clock alone. */
export function resumeClock(clock: TurnClock, now: number): TurnClock {
  if (clock.pausedAt === null) return clock;
  // Clamp: a backwards system clock must not hand back a negative wait and
  // make the turn look shorter than it was.
  const waited = Math.max(0, now - clock.pausedAt);
  return { start: clock.start + waited, pausedAt: null };
}

/** While paused the figure holds still, which is the visible half of this. */
export function elapsedMs(clock: TurnClock, now: number): number {
  const at = clock.pausedAt ?? now;
  return Math.max(0, at - clock.start);
}
