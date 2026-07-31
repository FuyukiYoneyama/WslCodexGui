// codex writes source references the way a terminal makes them clickable --
// `src/App.tsx:2827`, sometimes with a column (`:2827:14`), occasionally in
// GitHub's `#L42` form. The suffix is not part of the filename, so opening the
// href verbatim fails ("file not found") and the right-click menu was stuck on
// the same dead path. Split the suffix off before resolving; the line number
// itself has nowhere to go (neither openPath nor Explorer accepts one), so it
// is kept only for the copied address.

export interface LinkTarget {
  path: string;
  line: number | null;
}

const LINE_SUFFIX = /^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)$/;

export function splitLineSuffix(href: string): LinkTarget {
  const m = LINE_SUFFIX.exec(href);
  if (!m) return { path: href, line: null };
  const path = m[1];
  // Nothing left to open once the suffix is removed (`:42`), or all that is
  // left is a Windows drive letter (`C:42`) -- both mean the colon was never a
  // line separator, so leave the href alone.
  if (!path || /^[a-zA-Z]$/.test(path)) return { path: href, line: null };
  return { path, line: Number(m[2] ?? m[3]) };
}

// The address shown to the user / put on the clipboard: the resolved absolute
// path with the line number put back, so it round-trips into codex and into
// editors that understand `path:line`.
export function formatLinkAddress(absolutePath: string, line: number | null): string {
  return line === null ? absolutePath : `${absolutePath}:${line}`;
}
