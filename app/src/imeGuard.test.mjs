import assert from "node:assert/strict";
import test from "node:test";
import { IME_ANCHOR_TIMEOUT_MS, IME_HEAL_COOLDOWN_MS, ImeAnchorWatch, startsComposition } from "./imeGuard.ts";

// A manual clock + timer so the tests never wait in real time.
function harness() {
  let now = 10_000;
  let nextId = 1;
  const pending = new Map();
  let heals = 0;
  const watch = new ImeAnchorWatch({
    heal: () => {
      heals++;
    },
    now: () => now,
    setTimer: (fn, ms) => {
      const id = nextId++;
      pending.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimer: (id) => {
      pending.delete(id);
    },
  });
  return {
    watch,
    heals: () => heals,
    pendingCount: () => pending.size,
    advance(ms) {
      now += ms;
      for (const [id, t] of [...pending]) {
        if (t.at <= now) {
          pending.delete(id);
          t.fn();
        }
      }
    },
  };
}

const romaji = { keyCode: 229, code: "KeyH", isComposing: false };

test("only a romaji letter keydown from the IME counts as 'should start composing'", () => {
  assert.equal(startsComposition(romaji), true);
  // IME off: the page sees the real key, not 229
  assert.equal(startsComposition({ keyCode: 72, code: "KeyH", isComposing: false }), false);
  // already composing
  assert.equal(startsComposition({ ...romaji, isComposing: true }), false);
  // space / digits / punctuation can be committed by the IME with no composition
  assert.equal(startsComposition({ keyCode: 229, code: "Space", isComposing: false }), false);
  assert.equal(startsComposition({ keyCode: 229, code: "Digit1", isComposing: false }), false);
  assert.equal(startsComposition({ keyCode: 229, code: "Comma", isComposing: false }), false);
});

test("a composition that attaches in time is never healed", () => {
  const h = harness();
  h.watch.keyDown(romaji);
  h.advance(5); // healthy: compositionstart arrives within a few ms
  h.watch.compositionStart();
  h.advance(IME_ANCHOR_TIMEOUT_MS * 2);
  assert.equal(h.heals(), 0);
  assert.equal(h.pendingCount(), 0);
});

test("no compositionstart after the timeout means the IME is not attached: heal once", () => {
  const h = harness();
  h.watch.keyDown(romaji);
  h.advance(IME_ANCHOR_TIMEOUT_MS - 1);
  assert.equal(h.heals(), 0);
  h.advance(1);
  assert.equal(h.heals(), 1);
});

test("further keystrokes while a check is pending do not stack extra checks", () => {
  const h = harness();
  h.watch.keyDown(romaji);
  h.watch.keyDown({ ...romaji, code: "KeyO" });
  h.watch.keyDown({ ...romaji, code: "KeyN" });
  assert.equal(h.pendingCount(), 1);
  h.advance(IME_ANCHOR_TIMEOUT_MS);
  assert.equal(h.heals(), 1);
});

test("keystrokes inside a running composition are ignored", () => {
  const h = harness();
  h.watch.keyDown(romaji);
  h.watch.compositionStart();
  h.watch.keyDown({ ...romaji, code: "KeyO" }); // isComposing is true for real, but the flag alone is enough
  h.advance(IME_ANCHOR_TIMEOUT_MS * 2);
  assert.equal(h.heals(), 0);
});

test("after compositionend the next composition is watched again", () => {
  const h = harness();
  h.watch.keyDown(romaji);
  h.watch.compositionStart();
  h.watch.compositionEnd();
  h.watch.keyDown({ ...romaji, code: "KeyK" });
  h.advance(IME_ANCHOR_TIMEOUT_MS);
  assert.equal(h.heals(), 1);
});

test("a heal that did not take is not repeated on every keystroke", () => {
  const h = harness();
  h.watch.keyDown(romaji);
  h.advance(IME_ANCHOR_TIMEOUT_MS);
  assert.equal(h.heals(), 1);

  h.advance(100);
  h.watch.keyDown(romaji); // still broken, but inside the cooldown
  h.advance(IME_ANCHOR_TIMEOUT_MS);
  assert.equal(h.heals(), 1);

  h.advance(IME_HEAL_COOLDOWN_MS); // cooldown over
  h.watch.keyDown(romaji);
  h.advance(IME_ANCHOR_TIMEOUT_MS);
  assert.equal(h.heals(), 2);
});

test("dispose cancels a pending check", () => {
  const h = harness();
  h.watch.keyDown(romaji);
  h.watch.dispose();
  h.advance(IME_ANCHOR_TIMEOUT_MS * 2);
  assert.equal(h.heals(), 0);
});
