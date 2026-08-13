// One line standing in for a collapsed message.
//
// Collapsing is offered per message and driven entirely by the reader -- the
// app never decides that two messages "say the same thing" and folds one away
// on its own. That was considered and rejected: the pair that prompted this
// were only 50% similar (a restatement, not a repeat), so an exact-match rule
// would have missed them while a similarity threshold loose enough to catch
// them would also swallow genuinely different messages. Judging that two texts
// mean the same thing is an interpretation, and interpretation does not belong
// in the display layer -- see 残項目.md on keeping presentation and meaning
// apart. A collapsed message still shows it exists, and expanding restores it
// verbatim, so no fact is lost either way.

const MAX_PREVIEW_CHARS = 60;

export function collapsePreview(text: string): string {
  // itemToText prefixes a heading line ("あなた" / "Codex" etc.); the preview
  // wants the message itself, so skip leading blank or heading-only lines.
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "(空のメッセージ)";
  return line.length > MAX_PREVIEW_CHARS ? `${line.slice(0, MAX_PREVIEW_CHARS)}…` : line;
}
