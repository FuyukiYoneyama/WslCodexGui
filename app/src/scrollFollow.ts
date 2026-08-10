// Whether the transcript should keep pinning itself to the newest output.
//
// The transcript used to jam scrollTop to scrollHeight on every items change,
// which meant scrolling up to read earlier output during a turn got yanked
// back to the bottom the moment the next chunk arrived -- unusable exactly
// when a long turn makes reading back most useful.
//
// The rule is "follow only while the reader is already at the bottom". A
// small threshold rather than an exact match because scrollTop is fractional
// under display scaling, momentum scrolling overshoots by a pixel or two, and
// content-visibility makes offscreen heights estimates, so `scrollTop +
// clientHeight === scrollHeight` is never reliably true even when visually
// pinned.
export const BOTTOM_THRESHOLD_PX = 80;

export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function isNearBottom(m: ScrollMetrics, threshold = BOTTOM_THRESHOLD_PX): boolean {
  return m.scrollHeight - (m.scrollTop + m.clientHeight) <= threshold;
}
