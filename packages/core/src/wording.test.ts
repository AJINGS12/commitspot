import { describe, expect, it } from "vitest";
import { T, makePlan, makeState, ofType, step } from "./test-helpers.js";
import { fixedNoticeText, formatPlanTime } from "./wording.js";

const deadline = T("2026-11-26T12:00:00Z");

describe("formatPlanTime", () => {
  it("shows the time in the plan's own time zone", () => {
    expect(formatPlanTime(deadline, "Europe/London", "en-GB")).toBe("Thu 26 Nov, 12:00 GMT");
    expect(formatPlanTime(deadline, "America/New_York", "en-US")).toBe("Thu, Nov 26, 07:00 EST");
  });
});

describe("fixedNoticeText: re-approval (wording is fixed, never left to the LLM)", () => {
  const plan = makePlan({ timezone: "Europe/London" });

  it("warns clearly that the spot goes to the waitlist if they don't re-approve in time", () => {
    expect(fixedNoticeText({ kind: "REAPPROVAL_NEEDED", commitmentId: "c-p1", deadline }, plan, "en-GB")).toBe(
      "Your PayPal hold needs a quick re-approval to keep your spot. " +
        "If you don't re-approve by Thu 26 Nov, 12:00 GMT, your spot will be offered to the waitlist.",
    );
  });

  it("explains what happens next once the window has passed", () => {
    expect(fixedNoticeText({ kind: "REAPPROVAL_EXPIRED", commitmentId: "c-p1" }, plan, "en-GB")).toBe(
      "You didn't re-approve your PayPal hold in time, so your spot is now offered to the waitlist. " +
        "If someone takes it, your hold is released and you pay nothing. " +
        "If nobody does, you keep your spot and your share is charged from your existing hold at the cutoff.",
    );
  });

  it("refuses to word a re-approval request without its deadline", () => {
    expect(() => fixedNoticeText({ kind: "REAPPROVAL_NEEDED", commitmentId: "c-p1" }, plan)).toThrow(RangeError);
  });

  it("leaves other notices to the agent", () => {
    expect(fixedNoticeText({ kind: "LOCKED_IN", commitmentId: "c-p1" }, plan)).toBeUndefined();
  });

  it("words the notice the engine actually sends when a reauthorization fails", () => {
    const longPlan = {
      startsAt: T("2026-11-27T18:00:00Z"),
      freeDropoutDeadline: T("2026-11-25T18:00:00Z"),
      captureCutoff: T("2026-11-27T12:00:00Z"),
    };
    const at = T("2026-11-07T12:00:00Z");
    let s = step(makeState(longPlan), { type: "OPEN_PLAN", byParticipantId: "org" }, at).state;
    s = step(s, { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, at).state;
    s = step(s, { type: "ORDER_CREATED", commitmentId: "c-p1", orderId: "o1" }, at).state;
    s = step(s, { type: "ORDER_APPROVED", commitmentId: "c-p1", orderId: "o1" }, at).state;
    s = step(s, { type: "AUTHORIZATION_SUCCEEDED", commitmentId: "c-p1", authorizationId: "a1" }, at).state;
    const failAt = T("2026-11-25T12:00:00Z");
    s = step(s, { type: "REAUTH_DUE", commitmentId: "c-p1" }, failAt).state;
    const r = step(s, { type: "REAUTH_FAILED", commitmentId: "c-p1", reason: "DECLINED" }, failAt);

    const notice = ofType(r.effects, "NOTIFY").find((n) => n.notice.kind === "REAPPROVAL_NEEDED")?.notice;
    expect(notice).toBeDefined();
    if (!notice) return;
    expect(fixedNoticeText(notice, r.state.plan, "en-GB")).toContain("If you don't re-approve by Thu 26 Nov, 12:00 GMT,");
  });
});
