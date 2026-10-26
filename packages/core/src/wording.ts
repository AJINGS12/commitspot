/**
 * Fixed participant-facing wording for notices where the exact words carry consequences.
 * When `fixedNoticeText` returns a string, the executor sends it verbatim: the LLM may add
 * friendliness around it but must never replace or reword it.
 */
import type { Notice, Plan } from "./types.js";

/** e.g. "Thu 26 Nov, 12:00 GMT" (en-GB) in the plan's own time zone. */
export function formatPlanTime(at: Date, timeZone: string, locale = "en-GB"): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone,
    timeZoneName: "short",
  }).format(at);
}

export function fixedNoticeText(notice: Notice, plan: Plan, locale = "en-GB"): string | undefined {
  switch (notice.kind) {
    case "REAPPROVAL_NEEDED": {
      // Someone who still plans to come can lose their spot here, so the warning must be explicit.
      if (!notice.deadline) throw new RangeError("REAPPROVAL_NEEDED notice has no deadline");
      const by = formatPlanTime(notice.deadline, plan.timezone, locale);
      return (
        "Your PayPal hold needs a quick re-approval to keep your spot. " +
        `If you don't re-approve by ${by}, your spot will be offered to the waitlist.`
      );
    }
    case "REAPPROVAL_EXPIRED":
      return (
        "You didn't re-approve your PayPal hold in time, so your spot is now offered to the waitlist. " +
        "If someone takes it, your hold is released and you pay nothing. " +
        "If nobody does, you keep your spot and your share is charged from your existing hold at the cutoff."
      );
    default:
      return undefined;
  }
}
