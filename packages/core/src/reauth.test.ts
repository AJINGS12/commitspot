import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_VALIDITY_MS,
  HONOR_PERIOD_MS,
  MAX_JOIN_LEAD_MS,
  REAUTH_EARLIEST_MARGIN_MS,
  REAUTH_LEAD_MS,
  cutoffInReauthGap,
  planReauthorization,
  reapprovalDeadline,
} from "./reauth.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const authorizedAt = new Date("2026-11-01T10:00:00Z");
const after = (ms: number) => new Date(authorizedAt.getTime() + ms);

describe("constants match PayPal (CLAUDE.md 8.2 + day-1 gate)", () => {
  it("uses a 3-day honor period, a 29-day validity and a join lead inside it", () => {
    expect(HONOR_PERIOD_MS).toBe(3 * DAY);
    expect(AUTHORIZATION_VALIDITY_MS).toBe(29 * DAY);
    expect(MAX_JOIN_LEAD_MS).toBeLessThan(AUTHORIZATION_VALIDITY_MS);
    expect(REAUTH_LEAD_MS).toBeLessThan(HONOR_PERIOD_MS);
    // Safe margin after 72 h until the 30 Oct sandbox retry confirms PayPal's exact "day 4".
    expect(REAUTH_EARLIEST_MARGIN_MS).toBe(HOUR);
  });
});

describe("planReauthorization", () => {
  it("needs nothing when the cutoff is inside the original honor period", () => {
    expect(planReauthorization({ authorizedAt, captureCutoff: after(2 * DAY) })).toEqual({ kind: "NOT_NEEDED" });
  });

  it("treats a cutoff exactly at the end of the honor period as covered", () => {
    expect(planReauthorization({ authorizedAt, captureCutoff: after(3 * DAY) })).toEqual({ kind: "NOT_NEEDED" });
  });

  it("schedules at the earliest allowed moment (72 h + margin) when the cutoff is just past the honor period", () => {
    const result = planReauthorization({ authorizedAt, captureCutoff: after(3 * DAY + 2 * HOUR) });
    // PayPal rejects reauthorization before day 4 (REAUTHORIZATION_TOO_SOON in the gate run).
    expect(result).toEqual({ kind: "SCHEDULE", at: after(3 * DAY + REAUTH_EARLIEST_MARGIN_MS) });
  });

  it("reports when the cutoff falls between the honor period and the earliest safe reauthorization", () => {
    expect(planReauthorization({ authorizedAt, captureCutoff: after(3 * DAY + 30 * 60_000) })).toEqual({
      kind: "NOT_POSSIBLE",
      reason: "NO_ROOM_BEFORE_CUTOFF",
    });
  });

  it("for long plans schedules once, shortly before the cutoff, so the new honor period covers it", () => {
    const cutoff = after(20 * DAY);
    const result = planReauthorization({ authorizedAt, captureCutoff: cutoff });
    expect(result).toEqual({ kind: "SCHEDULE", at: new Date(cutoff.getTime() - REAUTH_LEAD_MS) });
  });

  it("satisfies PayPal's window for every plan length up to the join lead", () => {
    for (let span = 1; span <= MAX_JOIN_LEAD_MS; span += HOUR) {
      const cutoff = after(span);
      const result = planReauthorization({ authorizedAt, captureCutoff: cutoff });
      if (span <= HONOR_PERIOD_MS) {
        expect(result.kind).toBe("NOT_NEEDED");
        continue;
      }
      if (span <= HONOR_PERIOD_MS + REAUTH_EARLIEST_MARGIN_MS) {
        expect(result).toEqual({ kind: "NOT_POSSIBLE", reason: "NO_ROOM_BEFORE_CUTOFF" });
        continue;
      }
      expect(result.kind).toBe("SCHEDULE");
      if (result.kind !== "SCHEDULE") continue;
      const at = result.at.getTime();
      expect(at).toBeGreaterThanOrEqual(after(HONOR_PERIOD_MS + REAUTH_EARLIEST_MARGIN_MS).getTime()); // not too soon
      expect(at).toBeLessThanOrEqual(after(AUTHORIZATION_VALIDITY_MS).getTime()); // before day 29
      expect(at).toBeLessThan(cutoff.getTime()); // before the capture
      expect(cutoff.getTime() - at).toBeLessThanOrEqual(HONOR_PERIOD_MS); // new honor period covers the cutoff
    }
  });

  describe("single reauthorization (PayPal allows it once, day 4 to day 29)", () => {
    it("needs nothing more when the one reauthorization already covers the cutoff", () => {
      const cutoff = after(20 * DAY);
      const reauthorizedAt = new Date(cutoff.getTime() - REAUTH_LEAD_MS);
      expect(planReauthorization({ authorizedAt, reauthorizedAt, captureCutoff: cutoff })).toEqual({ kind: "NOT_NEEDED" });
    });

    it("never schedules a second reauthorization", () => {
      const cutoff = after(20 * DAY);
      const reauthorizedAt = after(4 * DAY);
      expect(planReauthorization({ authorizedAt, reauthorizedAt, captureCutoff: cutoff })).toEqual({
        kind: "NOT_POSSIBLE",
        reason: "ALREADY_REAUTHORIZED",
      });
    });
  });

  it("refuses cutoffs beyond the 29-day authorization validity", () => {
    expect(planReauthorization({ authorizedAt, captureCutoff: after(29 * DAY + 1) })).toEqual({
      kind: "NOT_POSSIBLE",
      reason: "BEYOND_AUTHORIZATION_VALIDITY",
    });
  });
});

describe("reapprovalDeadline (failed reauthorization)", () => {
  const failedAt = new Date("2026-11-20T12:00:00Z");
  it("gives 24 hours when the cutoff is far away", () => {
    expect(reapprovalDeadline(failedAt, new Date("2026-11-25T12:00:00Z"))).toEqual(new Date("2026-11-21T12:00:00Z"));
  });
  it("closes 2 hours before the cutoff when that comes first", () => {
    expect(reapprovalDeadline(failedAt, new Date("2026-11-21T08:00:00Z"))).toEqual(new Date("2026-11-21T06:00:00Z"));
  });
});

describe("cutoffInReauthGap", () => {
  const now = new Date("2026-11-01T12:00:00Z");
  const cutoffAfter = (ms: number) => new Date(now.getTime() + ms);
  it("is true only when the cutoff is 72 h (exclusive) to 73 h (inclusive) away", () => {
    expect(cutoffInReauthGap(cutoffAfter(72 * HOUR), now)).toBe(false);
    expect(cutoffInReauthGap(cutoffAfter(72 * HOUR + 1), now)).toBe(true);
    expect(cutoffInReauthGap(cutoffAfter(72 * HOUR + 30 * 60_000), now)).toBe(true);
    expect(cutoffInReauthGap(cutoffAfter(73 * HOUR), now)).toBe(true);
    expect(cutoffInReauthGap(cutoffAfter(73 * HOUR + 1), now)).toBe(false);
  });
});
