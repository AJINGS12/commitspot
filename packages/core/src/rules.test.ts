import { describe, expect, it } from "vitest";
import { MAX_JOIN_LEAD_MS } from "./reauth.js";
import {
  PLAN_DEFAULTS,
  isLateDropout,
  joinOpensAt,
  planWarnings,
  lateDropoutChargeMinor,
  rulesSnapshot,
  rulesSummary,
  validatePlanRules,
} from "./rules.js";
import { makePlan, T } from "./test-helpers.js";

const now = T("2026-11-01T12:00:00Z");

function codes(plan: Parameters<typeof validatePlanRules>[0]): string[] {
  const r = validatePlanRules(plan, now);
  return r.ok ? [] : r.error.map((v) => v.code);
}

describe("validatePlanRules", () => {
  it("accepts a well-formed plan", () => {
    expect(validatePlanRules(makePlan(), now)).toEqual({ ok: true, value: undefined });
  });

  it("requires integer minor-unit prices above zero", () => {
    expect(codes(makePlan({ pricePerSpotMinor: 5.5 }))).toContain("PRICE_INVALID");
    expect(codes(makePlan({ pricePerSpotMinor: 0 }))).toContain("PRICE_INVALID");
  });

  it("requires a whole number of spots and a sensible minimum headcount", () => {
    expect(codes(makePlan({ spots: 0 }))).toContain("SPOTS_INVALID");
    expect(codes(makePlan({ spots: 2.5 }))).toContain("SPOTS_INVALID");
    expect(codes(makePlan({ spots: 4, minHeadcount: 5 }))).toContain("MIN_HEADCOUNT_INVALID");
    expect(codes(makePlan({ spots: 4, minHeadcount: 0 }))).toContain("MIN_HEADCOUNT_INVALID");
    expect(codes(makePlan({ spots: 4, minHeadcount: 3 }))).toEqual([]);
  });

  it("requires a PayPal currency and a real IANA time zone", () => {
    expect(codes(makePlan({ currency: "NGN" }))).toContain("CURRENCY_NOT_SUPPORTED");
    expect(codes(makePlan({ timezone: "Mars/Olympus" }))).toContain("TIMEZONE_INVALID");
    expect(codes(makePlan({ timezone: "Africa/Lagos" }))).toEqual([]);
  });

  it("requires a non-empty title", () => {
    expect(codes(makePlan({ title: "   " }))).toContain("TITLE_EMPTY");
  });

  it("requires deadline <= cutoff <= start, with the cutoff in the future", () => {
    expect(codes(makePlan({ freeDropoutDeadline: T("2026-11-07T13:00:00Z") }))).toContain("DEADLINE_AFTER_CUTOFF");
    expect(codes(makePlan({ captureCutoff: T("2026-11-07T19:00:00Z") }))).toContain("CUTOFF_AFTER_START");
    const past = makePlan({
      freeDropoutDeadline: T("2026-10-30T12:00:00Z"),
      captureCutoff: T("2026-10-31T12:00:00Z"),
    });
    expect(codes(past)).toContain("CUTOFF_IN_PAST");
  });

  it("validates SPLIT_PERCENT and refuses a split that rounds to nothing", () => {
    expect(codes(makePlan({ noReplacementRule: { kind: "SPLIT_PERCENT", percent: 0 } }))).toContain("SPLIT_PERCENT_INVALID");
    expect(codes(makePlan({ noReplacementRule: { kind: "SPLIT_PERCENT", percent: 101 } }))).toContain("SPLIT_PERCENT_INVALID");
    expect(codes(makePlan({ noReplacementRule: { kind: "SPLIT_PERCENT", percent: 33.3 } }))).toContain("SPLIT_PERCENT_INVALID");
    expect(
      codes(makePlan({ pricePerSpotMinor: 1, noReplacementRule: { kind: "SPLIT_PERCENT", percent: 50 } })),
    ).toContain("SPLIT_CHARGE_ROUNDS_TO_ZERO");
    expect(codes(makePlan({ noReplacementRule: { kind: "SPLIT_PERCENT", percent: 50 } }))).toEqual([]);
  });

  it("defaults to FULL_SHARE with emergency release enabled", () => {
    expect(PLAN_DEFAULTS).toEqual({ noReplacementRule: { kind: "FULL_SHARE" }, emergencyReleaseEnabled: true });
  });
});

describe("isLateDropout (deadline is exclusive)", () => {
  const plan = makePlan();
  it("is early 1 ms before the deadline", () => {
    expect(isLateDropout(plan, new Date(plan.freeDropoutDeadline.getTime() - 1))).toBe(false);
  });
  it("is late exactly at the deadline", () => {
    expect(isLateDropout(plan, plan.freeDropoutDeadline)).toBe(true);
  });
  it("is late after the deadline", () => {
    expect(isLateDropout(plan, new Date(plan.freeDropoutDeadline.getTime() + 1))).toBe(true);
  });
});

describe("lateDropoutChargeMinor", () => {
  it("charges the full share under FULL_SHARE", () => {
    expect(lateDropoutChargeMinor({ kind: "FULL_SHARE" }, 500)).toBe(500);
  });
  it("charges a rounded-down percentage under SPLIT_PERCENT, never more than the share", () => {
    expect(lateDropoutChargeMinor({ kind: "SPLIT_PERCENT", percent: 50 }, 333)).toBe(166);
  });
});

describe("joinOpensAt", () => {
  it("opens joining at most MAX_JOIN_LEAD before the cutoff", () => {
    const plan = makePlan();
    expect(joinOpensAt(plan).getTime()).toBe(plan.captureCutoff.getTime() - MAX_JOIN_LEAD_MS);
  });
});

describe("rulesSnapshot", () => {
  it("captures the rules a participant agrees to", () => {
    const plan = makePlan();
    expect(rulesSnapshot(plan)).toEqual({
      planId: plan.id,
      title: plan.title,
      currency: "USD",
      amountMinor: 500,
      timezone: "Europe/London",
      freeDropoutDeadline: "2026-11-05T18:00:00.000Z",
      captureCutoff: "2026-11-07T12:00:00.000Z",
      noReplacementRule: { kind: "FULL_SHARE" },
      emergencyReleaseEnabled: true,
    });
  });
});

describe("rulesSummary (plan card and approval page)", () => {
  it("states the full-share rule", () => {
    const plan = makePlan({ emergencyReleaseEnabled: false });
    expect(rulesSummary(plan, "participants")).toEqual([
      "If you drop out after the free-dropout deadline and nobody takes your spot, you pay your full share ($5.00).",
    ]);
    expect(rulesSummary(plan, "organizer")).toEqual(["Late dropouts whose spot isn't filled pay their full share ($5.00)."]);
  });

  it("says clearly that the organizer covers the rest under SPLIT_PERCENT", () => {
    const plan = makePlan({ noReplacementRule: { kind: "SPLIT_PERCENT", percent: 50 }, emergencyReleaseEnabled: false });
    expect(rulesSummary(plan, "participants")).toEqual([
      "If you drop out after the free-dropout deadline and nobody takes your spot, you pay 50% of your share ($2.50); the organizer covers the rest.",
    ]);
    expect(rulesSummary(plan, "organizer")).toEqual([
      "Late dropouts pay 50% ($2.50) if nobody takes their spot; you cover the rest ($2.50).",
    ]);
  });

  it("mentions the emergency release only when it is enabled", () => {
    const plan = makePlan({ emergencyReleaseEnabled: true });
    expect(rulesSummary(plan, "participants")[1]).toBe(
      "In an emergency you can ask the organizer to release you; if they agree, you pay nothing.",
    );
    expect(rulesSummary(plan, "organizer")[1]).toBe(
      "In an emergency, a late dropout can ask you to release them; if you agree, they pay nothing.",
    );
    expect(rulesSummary(makePlan({ emergencyReleaseEnabled: false }), "participants")).toHaveLength(1);
  });
});

describe("planWarnings (shown to the organizer before the plan opens)", () => {
  const HOUR = 60 * 60 * 1000;
  const cutoffIn = (ms: number) => makePlan({ captureCutoff: new Date(now.getTime() + ms) });
  it("warns when the cutoff falls in the 1-hour reauthorization gap", () => {
    expect(planWarnings(cutoffIn(72 * HOUR + 30 * 60_000), now).map((w) => w.code)).toEqual(["CUTOFF_IN_REAUTH_GAP"]);
  });
  it("stays quiet otherwise", () => {
    expect(planWarnings(cutoffIn(72 * HOUR), now)).toEqual([]);
    expect(planWarnings(cutoffIn(5 * 24 * HOUR), now)).toEqual([]);
  });
});
