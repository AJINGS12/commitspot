/**
 * PayPal authorization timing (CLAUDE.md 8.2, confirmed by the day-1 gate):
 * - an authorization is valid for 29 days from the ORIGINAL authorization;
 * - captures are only guaranteed inside a 3-day honor period;
 * - it can be reauthorized ONCE, from day 4 to day 29 (earlier → REAUTHORIZATION_TOO_SOON;
 *   the engine waits 72 h + REAUTH_EARLIEST_MARGIN_MS to be safe),
 *   which returns a new authorization id with a fresh 3-day honor period.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const HONOR_PERIOD_MS = 3 * DAY_MS;
export const AUTHORIZATION_VALIDITY_MS = 29 * DAY_MS;
/**
 * Safety margin after 72 h before the first reauthorization attempt. Keep until the
 * 30 Oct 2026 sandbox retry confirms exactly when PayPal's "day 4" starts.
 */
export const REAUTH_EARLIEST_MARGIN_MS = 60 * 60 * 1000;
/** Reauthorize this long before the cutoff, leaving time to retry or react to a failure. */
export const REAUTH_LEAD_MS = 2 * DAY_MS;
/** Joining opens at most this long before the cutoff (~4 weeks, inside the 29-day validity). */
export const MAX_JOIN_LEAD_MS = 28 * DAY_MS;

export type ReauthPlan =
  | { kind: "NOT_NEEDED" }
  | { kind: "SCHEDULE"; at: Date }
  | {
      kind: "NOT_POSSIBLE";
      /**
       * NO_ROOM_BEFORE_CUTOFF: the cutoff falls less than the margin after the honor period.
       * The capture still works (the authorization is valid to day 29) but is no longer guaranteed.
       */
      reason: "ALREADY_REAUTHORIZED" | "BEYOND_AUTHORIZATION_VALIDITY" | "NO_ROOM_BEFORE_CUTOFF";
    };

export interface ReauthInput {
  /** Time of the original authorization. */
  authorizedAt: Date;
  /** Set if the single reauthorization already happened. */
  reauthorizedAt?: Date;
  captureCutoff: Date;
}

export function planReauthorization({ authorizedAt, reauthorizedAt, captureCutoff }: ReauthInput): ReauthPlan {
  const original = authorizedAt.getTime();
  const cutoff = captureCutoff.getTime();

  if (cutoff - original <= HONOR_PERIOD_MS) return { kind: "NOT_NEEDED" };

  if (reauthorizedAt) {
    return cutoff - reauthorizedAt.getTime() <= HONOR_PERIOD_MS
      ? { kind: "NOT_NEEDED" }
      : { kind: "NOT_POSSIBLE", reason: "ALREADY_REAUTHORIZED" };
  }

  if (cutoff - original > AUTHORIZATION_VALIDITY_MS) {
    return { kind: "NOT_POSSIBLE", reason: "BEYOND_AUTHORIZATION_VALIDITY" };
  }

  // As late as possible (so the new honor period covers the cutoff), but not before day 4 + margin.
  const at = Math.max(earliestReauthorization(authorizedAt).getTime(), cutoff - REAUTH_LEAD_MS);
  if (at >= cutoff) return { kind: "NOT_POSSIBLE", reason: "NO_ROOM_BEFORE_CUTOFF" };
  return { kind: "SCHEDULE", at: new Date(at) };
}

/** First moment the engine will try to reauthorize (72 h + margin after the original). */
export function earliestReauthorization(authorizedAt: Date): Date {
  return new Date(authorizedAt.getTime() + HONOR_PERIOD_MS + REAUTH_EARLIEST_MARGIN_MS);
}

/** After a failed reauthorization, the participant gets this long to re-approve... */
export const REAPPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
/** ...but the window always closes this long before the cutoff, so the spot can still be offered. */
export const REAPPROVAL_CUTOFF_BUFFER_MS = 2 * 60 * 60 * 1000;

/** Re-approval deadline: min(failure + 24 h, cutoff − 2 h). May already be in the past. */
export function reapprovalDeadline(failedAt: Date, captureCutoff: Date): Date {
  return new Date(Math.min(failedAt.getTime() + REAPPROVAL_WINDOW_MS, captureCutoff.getTime() - REAPPROVAL_CUTOFF_BUFFER_MS));
}

/**
 * True when someone authorizing at `at` could never get a reauthorization before the cutoff
 * (the cutoff is 72 h to 72 h + margin away): their capture would not be guaranteed.
 */
export function cutoffInReauthGap(captureCutoff: Date, at: Date): boolean {
  const plan = planReauthorization({ authorizedAt: at, captureCutoff });
  return plan.kind === "NOT_POSSIBLE" && plan.reason === "NO_ROOM_BEFORE_CUTOFF";
}
