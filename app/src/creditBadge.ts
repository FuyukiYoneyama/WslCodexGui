import type { RateLimitSnapshot } from "./types";

// What the footer's 💳 pill should show, if anything.
//
// The balance was previously surfaced only once a rate-limit window hit 100%
// -- i.e. only as an alarm at the moment real money started being spent. But
// account/rateLimits/read carries the balance the whole time (verified live:
// `"credits": {"hasCredits": true, "unlimited": false, "balance":
// "1234.5678900000"}` alongside a primary window at 25%), and there is no
// reason to withhold it until it is already too late to react.
//
// `drawing` keeps the old distinction so the pill can stay a plain readout
// normally and switch to the alarm colour only when the plan quota really is
// exhausted -- "now spending credits" is a different message from "you have
// credits".
export interface CreditBadge {
  balance: string;
  drawing: boolean;
}

// Balance arrives as a decimal *string* with far more precision than is
// useful (see above); two places is what a currency-like figure reads as.
function formatBalance(balance: string | null): string {
  const n = balance === null ? NaN : Number(balance);
  return Number.isFinite(n) ? n.toFixed(2) : (balance ?? "?");
}

export function creditBadge(rateLimits: RateLimitSnapshot): CreditBadge | null {
  const credits = rateLimits.credits;
  // No credits on the account, or an unlimited plan where a remaining
  // balance is not a meaningful number to show.
  if (!credits?.hasCredits || credits.unlimited) return null;
  return {
    balance: formatBalance(credits.balance ?? null),
    drawing:
      (rateLimits.primary?.usedPercent ?? 0) >= 100 ||
      (rateLimits.secondary?.usedPercent ?? 0) >= 100,
  };
}
