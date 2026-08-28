// Labels a rate-limit window by its actual duration instead of a fixed
// "primary"/"secondary" letter. OpenAI has added and removed windows over
// time (the 5-hour window was suspended for a while, then came back), and
// which API slot (primary vs secondary) a given window lands in isn't tied
// to a specific duration -- so a hardcoded "P"/"S" pair can silently point
// at the wrong window once the account's set of windows changes.
export function rateLimitWindowLabel(windowDurationMins: number | null): string {
  if (windowDurationMins === null) return "枠";
  if (windowDurationMins < 60) return `${windowDurationMins}分`;
  if (windowDurationMins % (24 * 60) === 0) {
    const days = windowDurationMins / (24 * 60);
    return days % 7 === 0 ? `${days / 7}週` : `${days}日`;
  }
  const hours = windowDurationMins / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}
