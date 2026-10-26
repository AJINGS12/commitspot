import { describe, expect, it } from "vitest";
import { REAUTH_LEAD_MS } from "./reauth.js";
import { CONFIRMATION_TTL_MS } from "./stateMachine.js";
import { T, allResults, makePlan, makeState, moneyEffects, ofType, step, stepFails } from "./test-helpers.js";
import type { Effect, Plan, PlanState } from "./types.js";

// Timeline for the default plan (see makePlan): deadline Thu 5 Nov 18:00, cutoff Sat 7 Nov 12:00, start 18:00.
const OPEN_AT = T("2026-11-01T12:00:00Z");
const BEFORE_DEADLINE = T("2026-11-04T12:00:00Z");
const DEADLINE = T("2026-11-05T18:00:00Z");
const AFTER_DEADLINE = T("2026-11-06T12:00:00Z");
const CUTOFF = T("2026-11-07T12:00:00Z");
const AFTER_CUTOFF = T("2026-11-07T12:30:00Z");
const AFTER_START = T("2026-11-07T19:00:00Z");
const plus = (d: Date, ms: number) => new Date(d.getTime() + ms);
const MIN = 60_000;

function openPlan(overrides: Partial<Plan> = {}, at = OPEN_AT): PlanState {
  return step(makeState(overrides), { type: "OPEN_PLAN", byParticipantId: "org" }, at).state;
}

/** Order created and approved, authorization requested but not yet confirmed. */
function approve(state: PlanState, commitmentId: string, at: Date, attempt = 1): PlanState {
  const orderId = `order-${commitmentId}-${attempt}`;
  let s = step(state, { type: "ORDER_CREATED", commitmentId, orderId }, at).state;
  s = step(s, { type: "ORDER_APPROVED", commitmentId, orderId }, at).state;
  return s;
}

function authorize(state: PlanState, commitmentId: string, at: Date, authorizationId = `auth-${commitmentId}`) {
  return step(state, { type: "AUTHORIZATION_SUCCEEDED", commitmentId, authorizationId }, at);
}

/** Full join: request → order → approval → authorization. */
function join(state: PlanState, participantId: string, at = OPEN_AT): PlanState {
  const id = `c-${participantId}`;
  let s = step(state, { type: "JOIN_REQUESTED", commitmentId: id, participantId }, at).state;
  s = approve(s, id, at);
  return authorize(s, id, at).state;
}

function dropOut(state: PlanState, participantId: string, at: Date) {
  const commitmentId = `c-${participantId}`;
  const s = step(state, { type: "DROPOUT_REQUESTED", commitmentId, participantId }, at).state;
  return step(s, { type: "DROPOUT_CONFIRMED", commitmentId, participantId }, at);
}

/** Offer a spot to a participant and have them accept it (not yet authorized). Returns their commitment id. */
function offerAndAccept(state: PlanState, spotCommitmentId: string, participantId: string, at: Date) {
  const offerId = `offer-${participantId}-${spotCommitmentId}`;
  let s = step(
    state,
    { type: "OFFER_SENT", offerId, spotCommitmentId, offeredToParticipantId: participantId, expiresAt: plus(at, 60 * MIN) },
    at,
  ).state;
  const r = step(s, { type: "OFFER_ACCEPTED", offerId, participantId, commitmentId: `c-${participantId}` }, at);
  s = r.state;
  const c = Object.values(s.commitments).find((x) => x.participantId === participantId && x.status === "PENDING_APPROVAL");
  if (!c) throw new Error("no pending commitment after acceptance");
  return { state: approve(s, c.id, at, 2), commitmentId: c.id, offerId, effects: r.effects };
}

const statusOf = (s: PlanState, id: string) => s.commitments[id]?.status;
const notified = (effects: Effect[], participantId: string, kind?: string) =>
  ofType(effects, "NOTIFY").some(
    (n) => n.to.kind === "participant" && n.to.participantId === participantId && (!kind || n.notice.kind === kind),
  );

// ---------------------------------------------------------------------------

describe("opening a plan", () => {
  it("moves DRAFT → OPEN, schedules the cutoff job and tells the group", () => {
    const r = step(makeState(), { type: "OPEN_PLAN", byParticipantId: "org" }, OPEN_AT);
    expect(r.state.plan.status).toBe("OPEN");
    expect(ofType(r.effects, "SCHEDULE_JOB")).toEqual([
      { type: "SCHEDULE_JOB", job: { kind: "CUTOFF", planId: "plan-1" }, at: CUTOFF },
    ]);
    expect(ofType(r.effects, "NOTIFY").some((n) => n.to.kind === "group" && n.notice.kind === "PLAN_OPENED")).toBe(true);
  });

  it("only lets the organizer open it", () => {
    expect(stepFails(makeState(), { type: "OPEN_PLAN", byParticipantId: "p1" }, OPEN_AT).error.code).toBe("NOT_ORGANIZER");
  });

  it("refuses invalid rules", () => {
    const r = stepFails(makeState({ noReplacementRule: { kind: "SPLIT_PERCENT", percent: 0 } }), { type: "OPEN_PLAN", byParticipantId: "org" }, OPEN_AT);
    expect(r.error.code).toBe("RULES_INVALID");
  });

  it("warns the organizer when the cutoff falls in the 1-hour reauthorization gap", () => {
    const cutoff = plus(OPEN_AT, 72 * 60 * MIN + 30 * MIN);
    const plan = { freeDropoutDeadline: plus(cutoff, -60 * MIN), captureCutoff: cutoff, startsAt: plus(cutoff, 6 * 60 * MIN) };
    const r = step(makeState(plan), { type: "OPEN_PLAN", byParticipantId: "org" }, OPEN_AT);
    expect(r.state.plan.status).toBe("OPEN");
    expect(ofType(r.effects, "NOTIFY")).toContainEqual({ type: "NOTIFY", to: { kind: "organizer" }, notice: { kind: "CUTOFF_IN_REAUTH_GAP" } });
  });

  it("does not warn when the cutoff is outside the gap", () => {
    const r = step(makeState(), { type: "OPEN_PLAN", byParticipantId: "org" }, OPEN_AT);
    expect(ofType(r.effects, "NOTIFY").some((n) => n.notice.kind === "CUTOFF_IN_REAUTH_GAP")).toBe(false);
  });
});

describe("join flow: join + approval + authorization → COMMITTED", () => {
  it("creates a pending commitment and asks for a PayPal order, with no money action", () => {
    const r = step(openPlan(), { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, OPEN_AT);
    expect(statusOf(r.state, "c-p1")).toBe("PENDING_APPROVAL");
    expect(r.effects).toContainEqual({
      type: "CREATE_ORDER",
      commitmentId: "c-p1",
      amountMinor: 500,
      currency: "USD",
      description: "CommitSpot: Football Sat 6pm",
      purpose: "JOIN",
    });
    expect(moneyEffects(r.effects)).toEqual([]);
  });

  it("authorizes on approval and records the rules the participant accepted", () => {
    let s = step(openPlan(), { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, OPEN_AT).state;
    s = step(s, { type: "ORDER_CREATED", commitmentId: "c-p1", orderId: "o1" }, OPEN_AT).state;
    const r = step(s, { type: "ORDER_APPROVED", commitmentId: "c-p1", orderId: "o1" }, OPEN_AT);
    expect(ofType(r.effects, "AUTHORIZE")).toEqual([
      { type: "AUTHORIZE", moneyEventId: "c-p1:AUTHORIZE:o1", commitmentId: "c-p1", orderId: "o1", rule: "JOIN_APPROVED_AUTHORIZE" },
    ]);
    const [acceptance] = ofType(r.effects, "RECORD_RULES_ACCEPTANCE");
    expect(acceptance?.acceptance).toMatchObject({ commitmentId: "c-p1", acceptedAt: OPEN_AT });
    expect(acceptance?.acceptance.rulesSnapshot).toMatchObject({ amountMinor: 500, noReplacementRule: { kind: "FULL_SHARE" } });
  });

  it("commits once the authorization succeeds and tells the participant", () => {
    let s = step(openPlan(), { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, OPEN_AT).state;
    s = approve(s, "c-p1", OPEN_AT);
    const r = authorize(s, "c-p1", OPEN_AT);
    expect(r.state.commitments["c-p1"]).toMatchObject({
      status: "COMMITTED",
      paypalAuthorizationId: "auth-c-p1",
      authorizedAt: OPEN_AT,
      pendingMoneyActions: [],
    });
    expect(notified(r.effects, "p1", "LOCKED_IN")).toBe(true);
  });

  it("does not open joining more than ~4 weeks before the cutoff", () => {
    const far = openPlan({
      startsAt: T("2026-12-20T18:00:00Z"),
      freeDropoutDeadline: T("2026-12-18T18:00:00Z"),
      captureCutoff: T("2026-12-20T12:00:00Z"),
    });
    const r = stepFails(far, { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, OPEN_AT);
    expect(r.error.code).toBe("JOIN_NOT_YET_OPEN");
  });

  it("refuses a second active commitment for the same person", () => {
    const s = join(openPlan(), "p1");
    expect(stepFails(s, { type: "JOIN_REQUESTED", commitmentId: "c-p1b", participantId: "p1" }, OPEN_AT).error.code).toBe(
      "ALREADY_JOINED",
    );
  });

  it("refuses joins when every spot is committed", () => {
    const s = join(join(openPlan(), "p1"), "p2");
    expect(stepFails(s, { type: "JOIN_REQUESTED", commitmentId: "c-p3", participantId: "p3" }, OPEN_AT).error.code).toBe(
      "PLAN_FULL",
    );
  });

  it("gives the last spot to the first successful authorization and voids the other", () => {
    let s = join(openPlan(), "p1"); // one spot left
    s = step(s, { type: "JOIN_REQUESTED", commitmentId: "c-p2", participantId: "p2" }, OPEN_AT).state;
    s = step(s, { type: "JOIN_REQUESTED", commitmentId: "c-p3", participantId: "p3" }, OPEN_AT).state;
    s = approve(approve(s, "c-p2", OPEN_AT), "c-p3", OPEN_AT);
    s = authorize(s, "c-p3", OPEN_AT).state;
    expect(statusOf(s, "c-p3")).toBe("COMMITTED");
    const r = authorize(s, "c-p2", OPEN_AT);
    expect(statusOf(r.state, "c-p2")).toBe("WAITLISTED");
    expect(ofType(r.effects, "VOID")).toEqual([
      { type: "VOID", moneyEventId: "c-p2:VOID:auth-c-p2", commitmentId: "c-p2", authorizationId: "auth-c-p2", rule: "SPOT_TAKEN_VOID" },
    ]);
    expect(notified(r.effects, "p2", "SPOT_TAKEN")).toBe(true);
  });

  it("lets a participant retry after PayPal refuses the authorization", () => {
    let s = step(openPlan(), { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, OPEN_AT).state;
    s = approve(s, "c-p1", OPEN_AT);
    const failed = step(s, { type: "AUTHORIZATION_FAILED", commitmentId: "c-p1", reason: "INSTRUMENT_DECLINED" }, OPEN_AT);
    expect(failed.state.commitments["c-p1"]).toMatchObject({ status: "PENDING_APPROVAL", pendingMoneyActions: [] });
    expect(failed.state.commitments["c-p1"]?.paypalOrderId).toBeUndefined();
    expect(notified(failed.effects, "p1", "AUTHORIZATION_FAILED")).toBe(true);

    const retry = step(failed.state, { type: "JOIN_REQUESTED", commitmentId: "c-p1-retry", participantId: "p1" }, OPEN_AT);
    expect(ofType(retry.effects, "CREATE_ORDER")).toHaveLength(1);
    expect(ofType(retry.effects, "CREATE_ORDER")[0]?.commitmentId).toBe("c-p1");
    const done = authorize(approve(retry.state, "c-p1", OPEN_AT, 2), "c-p1", OPEN_AT);
    expect(statusOf(done.state, "c-p1")).toBe("COMMITTED");
  });

  it("puts people on the waitlist without touching money", () => {
    const r = step(openPlan(), { type: "JOIN_WAITLIST", commitmentId: "c-w1", participantId: "w1" }, OPEN_AT);
    expect(statusOf(r.state, "c-w1")).toBe("WAITLISTED");
    expect(moneyEffects(r.effects)).toEqual([]);
  });
});

describe("dropouts need explicit confirmation (rule 5)", () => {
  it("asks first and changes nothing", () => {
    const s = join(openPlan(), "p1");
    const r = step(s, { type: "DROPOUT_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, BEFORE_DEADLINE);
    expect(statusOf(r.state, "c-p1")).toBe("COMMITTED");
    expect(moneyEffects(r.effects)).toEqual([]);
    expect(ofType(r.effects, "ASK_CONFIRMATION")).toEqual([
      { type: "ASK_CONFIRMATION", participantId: "p1", commitmentId: "c-p1", question: { kind: "DROPOUT_EARLY" } },
    ]);
  });

  it("refuses a confirmation that was never asked for", () => {
    const s = join(openPlan(), "p1");
    const r = stepFails(s, { type: "DROPOUT_CONFIRMED", commitmentId: "c-p1", participantId: "p1" }, BEFORE_DEADLINE);
    expect(r.error.code).toBe("NO_PENDING_CONFIRMATION");
  });

  it("only lets people drop themselves out", () => {
    const s = join(openPlan(), "p1");
    const r = stepFails(s, { type: "DROPOUT_REQUESTED", commitmentId: "c-p1", participantId: "p2" }, BEFORE_DEADLINE);
    expect(r.error.code).toBe("NOT_YOUR_COMMITMENT");
  });

  it("forgets the request when the participant says no", () => {
    let s = join(openPlan(), "p1");
    s = step(s, { type: "DROPOUT_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, BEFORE_DEADLINE).state;
    s = step(s, { type: "DROPOUT_DECLINED", commitmentId: "c-p1", participantId: "p1" }, BEFORE_DEADLINE).state;
    expect(statusOf(s, "c-p1")).toBe("COMMITTED");
    expect(stepFails(s, { type: "DROPOUT_CONFIRMED", commitmentId: "c-p1", participantId: "p1" }, BEFORE_DEADLINE).error.code).toBe(
      "NO_PENDING_CONFIRMATION",
    );
  });

  it("asks again if the confirmation is stale", () => {
    let s = join(openPlan(), "p1");
    s = step(s, { type: "DROPOUT_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, BEFORE_DEADLINE).state;
    const r = step(s, { type: "DROPOUT_CONFIRMED", commitmentId: "c-p1", participantId: "p1" }, plus(BEFORE_DEADLINE, CONFIRMATION_TTL_MS + 1));
    expect(statusOf(r.state, "c-p1")).toBe("COMMITTED");
    expect(ofType(r.effects, "ASK_CONFIRMATION")).toHaveLength(1);
    expect(moneyEffects(r.effects)).toEqual([]);
  });

  it("asks again if the deadline passed between question and answer, since the consequence changed", () => {
    let s = join(openPlan(), "p1");
    const askedAt = plus(DEADLINE, -2 * MIN);
    s = step(s, { type: "DROPOUT_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, askedAt).state;
    const r = step(s, { type: "DROPOUT_CONFIRMED", commitmentId: "c-p1", participantId: "p1" }, DEADLINE);
    expect(statusOf(r.state, "c-p1")).toBe("COMMITTED");
    expect(moneyEffects(r.effects)).toEqual([]);
    expect(ofType(r.effects, "ASK_CONFIRMATION")[0]?.question.kind).toBe("DROPOUT_LATE");
  });
});

describe("early dropout: VOID → DROPPED_EARLY, spot reopened", () => {
  it("voids the authorization, reopens the spot and looks for a replacement", () => {
    const r = dropOut(join(openPlan(), "p1"), "p1", BEFORE_DEADLINE);
    expect(r.state.commitments["c-p1"]).toMatchObject({ status: "DROPPED_EARLY", droppedAt: BEFORE_DEADLINE });
    expect(ofType(r.effects, "VOID")).toEqual([
      { type: "VOID", moneyEventId: "c-p1:VOID:auth-c-p1", commitmentId: "c-p1", authorizationId: "auth-c-p1", rule: "EARLY_DROPOUT_VOID" },
    ]);
    expect(ofType(r.effects, "CAPTURE")).toEqual([]);
    expect(ofType(r.effects, "FIND_REPLACEMENT")).toEqual([{ type: "FIND_REPLACEMENT", spotCommitmentId: "c-p1" }]);
    expect(notified(r.effects, "p1", "DROPPED_EARLY")).toBe(true);
  });

  it("is early 1 ms before the deadline", () => {
    const r = dropOut(join(openPlan(), "p1"), "p1", plus(DEADLINE, -1));
    expect(statusOf(r.state, "c-p1")).toBe("DROPPED_EARLY");
  });

  it("frees the spot for a normal join", () => {
    const s = dropOut(join(join(openPlan(), "p1"), "p2"), "p1", BEFORE_DEADLINE).state;
    expect(statusOf(join(s, "p3", BEFORE_DEADLINE), "c-p3")).toBe("COMMITTED");
  });
});

describe("late dropout: DROPPED_LATE_SEEKING, no money action yet", () => {
  it("keeps the authorization, tells them the possible charge and looks for a replacement", () => {
    let s = join(openPlan(), "p1");
    const ask = step(s, { type: "DROPOUT_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, AFTER_DEADLINE);
    expect(ofType(ask.effects, "ASK_CONFIRMATION")[0]?.question).toEqual({
      kind: "DROPOUT_LATE",
      chargeIfUnfilledMinor: 500,
      currency: "USD",
      captureCutoff: CUTOFF,
    });
    s = ask.state;
    const r = step(s, { type: "DROPOUT_CONFIRMED", commitmentId: "c-p1", participantId: "p1" }, AFTER_DEADLINE);
    expect(statusOf(r.state, "c-p1")).toBe("DROPPED_LATE_SEEKING");
    expect(moneyEffects(r.effects)).toEqual([]);
    expect(ofType(r.effects, "FIND_REPLACEMENT")).toEqual([{ type: "FIND_REPLACEMENT", spotCommitmentId: "c-p1" }]);
  });

  it("is late exactly at the deadline (deadline is exclusive)", () => {
    const r = dropOut(join(openPlan(), "p1"), "p1", DEADLINE);
    expect(statusOf(r.state, "c-p1")).toBe("DROPPED_LATE_SEEKING");
    expect(moneyEffects(r.effects)).toEqual([]);
  });

  it("keeps the spot held, so a normal join cannot take it", () => {
    const s = dropOut(join(join(openPlan(), "p1"), "p2"), "p1", AFTER_DEADLINE).state;
    expect(stepFails(s, { type: "JOIN_REQUESTED", commitmentId: "c-p3", participantId: "p3" }, AFTER_DEADLINE).error.code).toBe(
      "PLAN_FULL",
    );
  });

  it("refuses dropouts after the cutoff", () => {
    const s = step(join(openPlan(), "p1"), { type: "CUTOFF_REACHED" }, CUTOFF).state;
    expect(stepFails(s, { type: "DROPOUT_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, AFTER_CUTOFF).error.code).toBe(
      "DROPOUT_CLOSED",
    );
  });
});

describe("replacement from the waitlist", () => {
  function lateDropoutState() {
    let s = join(join(openPlan(), "p1"), "p2");
    s = step(s, { type: "JOIN_WAITLIST", commitmentId: "c-w1", participantId: "w1" }, OPEN_AT).state;
    return dropOut(s, "p1", AFTER_DEADLINE).state;
  }

  it("never voids the original before the replacement is authorized", () => {
    const { state, effects } = offerAndAccept(lateDropoutState(), "c-p1", "w1", AFTER_DEADLINE);
    expect(statusOf(state, "c-p1")).toBe("DROPPED_LATE_SEEKING");
    expect(ofType(effects, "VOID")).toEqual([]);
    expect(state.commitments["c-w1"]).toMatchObject({ status: "PENDING_APPROVAL", replacesCommitmentId: "c-p1" });
  });

  it("reuses the waitlist entry instead of creating a second commitment", () => {
    const { state, commitmentId } = offerAndAccept(lateDropoutState(), "c-p1", "w1", AFTER_DEADLINE);
    expect(commitmentId).toBe("c-w1");
    expect(Object.values(state.commitments).filter((c) => c.participantId === "w1")).toHaveLength(1);
  });

  it("commits the replacement, then voids the original → REPLACED", () => {
    const { state } = offerAndAccept(lateDropoutState(), "c-p1", "w1", AFTER_DEADLINE);
    const r = authorize(state, "c-w1", AFTER_DEADLINE);
    expect(statusOf(r.state, "c-w1")).toBe("COMMITTED");
    expect(r.state.commitments["c-p1"]).toMatchObject({ status: "REPLACED", replacedByCommitmentId: "c-w1" });
    expect(ofType(r.effects, "VOID")).toEqual([
      { type: "VOID", moneyEventId: "c-p1:VOID:auth-c-p1", commitmentId: "c-p1", authorizationId: "auth-c-p1", rule: "REPLACEMENT_VOID" },
    ]);
    expect(notified(r.effects, "p1", "REPLACED")).toBe(true);
    expect(notified(r.effects, "w1", "LOCKED_IN")).toBe(true);
    expect(ofType(r.effects, "NOTIFY").some((n) => n.to.kind === "organizer" && n.notice.kind === "REPLACEMENT_JOINED")).toBe(true);
  });

  it("cancels other open offers for the spot once it is filled", () => {
    let s = lateDropoutState();
    s = step(s, { type: "OFFER_SENT", offerId: "o-x", spotCommitmentId: "c-p1", offeredToParticipantId: "x", expiresAt: plus(AFTER_DEADLINE, 60 * MIN) }, AFTER_DEADLINE).state;
    const { state } = offerAndAccept(s, "c-p1", "w1", AFTER_DEADLINE);
    expect(authorize(state, "c-w1", AFTER_DEADLINE).state.offers["o-x"]?.status).toBe("CANCELLED");
  });

  it("fills an early dropout's spot without any extra void", () => {
    let s = join(join(openPlan(), "p1"), "p2");
    s = dropOut(s, "p1", BEFORE_DEADLINE).state;
    const { state } = offerAndAccept(s, "c-p1", "w1", BEFORE_DEADLINE);
    const r = authorize(state, "c-w1", BEFORE_DEADLINE);
    expect(statusOf(r.state, "c-w1")).toBe("COMMITTED");
    expect(statusOf(r.state, "c-p1")).toBe("DROPPED_EARLY");
    expect(r.state.commitments["c-p1"]?.replacedByCommitmentId).toBe("c-w1");
    expect(ofType(r.effects, "VOID")).toEqual([]);
  });

  it("only lets the person the offer was sent to accept it", () => {
    let s = lateDropoutState();
    s = step(s, { type: "OFFER_SENT", offerId: "o1", spotCommitmentId: "c-p1", offeredToParticipantId: "w1", expiresAt: plus(AFTER_DEADLINE, 60 * MIN) }, AFTER_DEADLINE).state;
    const r = stepFails(s, { type: "OFFER_ACCEPTED", offerId: "o1", participantId: "x", commitmentId: "c-x" }, AFTER_DEADLINE);
    expect(r.error.code).toBe("NOT_OFFER_RECIPIENT");
  });

  it("refuses offers to people who already hold a spot", () => {
    const r = stepFails(
      lateDropoutState(),
      { type: "OFFER_SENT", offerId: "o1", spotCommitmentId: "c-p1", offeredToParticipantId: "p2", expiresAt: plus(AFTER_DEADLINE, 60 * MIN) },
      AFTER_DEADLINE,
    );
    expect(r.error.code).toBe("ALREADY_JOINED");
  });

  it("looks for the next candidate when an offer is declined or expires", () => {
    let s = lateDropoutState();
    const sent = (id: string, to: string) =>
      ({ type: "OFFER_SENT", offerId: id, spotCommitmentId: "c-p1", offeredToParticipantId: to, expiresAt: plus(AFTER_DEADLINE, 30 * MIN) }) as const;
    s = step(s, sent("o1", "w1"), AFTER_DEADLINE).state;
    const declined = step(s, { type: "OFFER_DECLINED", offerId: "o1", participantId: "w1" }, AFTER_DEADLINE);
    expect(declined.state.offers["o1"]?.status).toBe("DECLINED");
    expect(ofType(declined.effects, "FIND_REPLACEMENT")).toHaveLength(1);

    s = step(declined.state, sent("o2", "x"), AFTER_DEADLINE).state;
    expect(stepFails(s, { type: "OFFER_EXPIRED", offerId: "o2" }, plus(AFTER_DEADLINE, 10 * MIN)).error.code).toBe("OFFER_NOT_EXPIRED");
    const expired = step(s, { type: "OFFER_EXPIRED", offerId: "o2" }, plus(AFTER_DEADLINE, 30 * MIN));
    expect(expired.state.offers["o2"]?.status).toBe("EXPIRED");
    expect(ofType(expired.effects, "FIND_REPLACEMENT")).toHaveLength(1);
  });

  it("schedules offer expiry and never lets an offer outlive the cutoff", () => {
    const at = plus(CUTOFF, -10 * MIN);
    const r = step(
      lateDropoutState(),
      { type: "OFFER_SENT", offerId: "o1", spotCommitmentId: "c-p1", offeredToParticipantId: "w1", expiresAt: plus(at, 60 * MIN) },
      at,
    );
    expect(r.state.offers["o1"]?.expiresAt).toEqual(CUTOFF);
    expect(ofType(r.effects, "SCHEDULE_JOB")).toEqual([{ type: "SCHEDULE_JOB", job: { kind: "OFFER_EXPIRY", offerId: "o1" }, at: CUTOFF }]);
  });
});

describe("two acceptances of one spot", () => {
  function twoSpotsLateDropout() {
    return dropOut(join(join(openPlan(), "p1"), "p2"), "p1", AFTER_DEADLINE).state;
  }

  it("treats a repeated acceptance of the same offer as a no-op", () => {
    const { state, offerId } = offerAndAccept(twoSpotsLateDropout(), "c-p1", "w1", AFTER_DEADLINE);
    const again = step(state, { type: "OFFER_ACCEPTED", offerId, participantId: "w1", commitmentId: "c-w1" }, AFTER_DEADLINE);
    expect(again.noop).toBeDefined();
    expect(again.effects).toEqual([]);
  });

  it("lets the first authorization win and voids the second one", () => {
    let s = twoSpotsLateDropout();
    s = offerAndAccept(s, "c-p1", "w1", AFTER_DEADLINE).state;
    s = offerAndAccept(s, "c-p1", "w2", AFTER_DEADLINE).state;

    const first = authorize(s, "c-w2", AFTER_DEADLINE);
    expect(statusOf(first.state, "c-w2")).toBe("COMMITTED");
    expect(statusOf(first.state, "c-p1")).toBe("REPLACED");

    const second = authorize(first.state, "c-w1", AFTER_DEADLINE);
    expect(statusOf(second.state, "c-w1")).toBe("WAITLISTED");
    expect(ofType(second.effects, "VOID")).toEqual([
      { type: "VOID", moneyEventId: "c-w1:VOID:auth-c-w1", commitmentId: "c-w1", authorizationId: "auth-c-w1", rule: "SPOT_TAKEN_VOID" },
    ]);
    // The original was voided exactly once, by the first replacement.
    const voidsOfOriginal = [...first.effects, ...second.effects].filter((e) => e.type === "VOID" && e.commitmentId === "c-p1");
    expect(voidsOfOriginal).toHaveLength(1);
    expect(notified(second.effects, "w1", "SPOT_TAKEN")).toBe(true);
  });
});

describe("replacement accepted after the cutoff is rejected", () => {
  function seeking() {
    return dropOut(join(join(openPlan(), "p1"), "p2"), "p1", AFTER_DEADLINE).state;
  }

  it("rejects an acceptance at the cutoff even if the cutoff job has not run yet", () => {
    let s = seeking();
    s = step(s, { type: "OFFER_SENT", offerId: "o1", spotCommitmentId: "c-p1", offeredToParticipantId: "w1", expiresAt: CUTOFF }, AFTER_DEADLINE).state;
    const r = stepFails(s, { type: "OFFER_ACCEPTED", offerId: "o1", participantId: "w1", commitmentId: "c-w1" }, CUTOFF);
    expect(r.error.code).toBe("REPLACEMENT_AFTER_CUTOFF");
  });

  it("cancels open offers at the cutoff", () => {
    let s = seeking();
    s = step(s, { type: "OFFER_SENT", offerId: "o1", spotCommitmentId: "c-p1", offeredToParticipantId: "w1", expiresAt: CUTOFF }, AFTER_DEADLINE).state;
    s = step(s, { type: "CUTOFF_REACHED" }, CUTOFF).state;
    expect(s.offers["o1"]?.status).toBe("CANCELLED");
    expect(stepFails(s, { type: "OFFER_ACCEPTED", offerId: "o1", participantId: "w1", commitmentId: "c-w1" }, AFTER_CUTOFF).error.code).toBe(
      "OFFER_NOT_OPEN",
    );
  });

  it("voids a replacement authorization that lands after the cutoff and still charges the dropout", () => {
    const s = offerAndAccept(seeking(), "c-p1", "w1", plus(CUTOFF, -5 * MIN)).state;
    const cutoff = step(s, { type: "CUTOFF_REACHED" }, CUTOFF);
    expect(ofType(cutoff.effects, "CAPTURE").map((c) => c.commitmentId)).toEqual(["c-p1", "c-p2"]);

    const r = authorize(cutoff.state, "c-w1", AFTER_CUTOFF);
    expect(statusOf(r.state, "c-w1")).toBe("WAITLISTED");
    expect(ofType(r.effects, "VOID")).toEqual([
      { type: "VOID", moneyEventId: "c-w1:VOID:auth-c-w1", commitmentId: "c-w1", authorizationId: "auth-c-w1", rule: "LATE_AUTHORIZATION_VOID" },
    ]);
    expect(statusOf(r.state, "c-p1")).toBe("DROPPED_LATE_SEEKING");
    expect(r.state.commitments["c-p1"]?.pendingMoneyActions[0]?.action).toBe("CAPTURE");
  });

  it("does not authorize an approval that arrives after the cutoff", () => {
    let s = seeking();
    s = step(s, { type: "OFFER_SENT", offerId: "o1", spotCommitmentId: "c-p1", offeredToParticipantId: "w1", expiresAt: CUTOFF }, AFTER_DEADLINE).state;
    s = step(s, { type: "OFFER_ACCEPTED", offerId: "o1", participantId: "w1", commitmentId: "c-w1" }, AFTER_DEADLINE).state;
    s = step(s, { type: "ORDER_CREATED", commitmentId: "c-w1", orderId: "ow1" }, AFTER_DEADLINE).state;
    const r = step(s, { type: "ORDER_APPROVED", commitmentId: "c-w1", orderId: "ow1" }, CUTOFF);
    expect(ofType(r.effects, "AUTHORIZE")).toEqual([]);
    expect(statusOf(r.state, "c-w1")).toBe("WAITLISTED");
    expect(notified(r.effects, "w1", "JOIN_TOO_LATE")).toBe(true);
  });
});

describe("cutoff capture", () => {
  it("refuses to run before the cutoff", () => {
    expect(stepFails(join(openPlan(), "p1"), { type: "CUTOFF_REACHED" }, plus(CUTOFF, -1)).error.code).toBe("CUTOFF_NOT_REACHED");
  });

  it("locks the plan and captures every committed share in full", () => {
    const r = step(join(join(openPlan(), "p1"), "p2"), { type: "CUTOFF_REACHED" }, CUTOFF);
    expect(r.state.plan.status).toBe("LOCKED");
    expect(ofType(r.effects, "CAPTURE")).toEqual([
      { type: "CAPTURE", moneyEventId: "c-p1:CAPTURE:auth-c-p1", commitmentId: "c-p1", authorizationId: "auth-c-p1", amountMinor: 500, currency: "USD", finalCapture: true, rule: "CUTOFF_CAPTURE_COMMITTED" },
      { type: "CAPTURE", moneyEventId: "c-p2:CAPTURE:auth-c-p2", commitmentId: "c-p2", authorizationId: "auth-c-p2", amountMinor: 500, currency: "USD", finalCapture: true, rule: "CUTOFF_CAPTURE_COMMITTED" },
    ]);
    expect(notified(r.effects, "p1", "CHARGING")).toBe(true);
  });

  it("marks a successful capture as PAID", () => {
    let s = step(join(openPlan(), "p1"), { type: "CUTOFF_REACHED" }, CUTOFF).state;
    const r = step(s, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap1", amountMinor: 500 }, CUTOFF);
    s = r.state;
    expect(s.commitments["c-p1"]).toMatchObject({ status: "PAID", captureId: "cap1", capturedAmountMinor: 500, pendingMoneyActions: [] });
    expect(notified(r.effects, "p1", "CHARGED")).toBe(true);
  });

  it("charges an unreplaced late dropout their full share under FULL_SHARE → CHARGED_MISSED_SPOT", () => {
    let s = dropOut(join(openPlan(), "p1"), "p1", AFTER_DEADLINE).state;
    const r = step(s, { type: "CUTOFF_REACHED" }, CUTOFF);
    expect(ofType(r.effects, "CAPTURE")).toEqual([
      expect.objectContaining({ commitmentId: "c-p1", amountMinor: 500, rule: "CUTOFF_CAPTURE_LATE_DROPOUT_FULL_SHARE" }),
    ]);
    s = step(r.state, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap1", amountMinor: 500 }, CUTOFF).state;
    expect(statusOf(s, "c-p1")).toBe("CHARGED_MISSED_SPOT");
  });

  it("charges only the agreed percentage under SPLIT_PERCENT", () => {
    const s = dropOut(join(openPlan({ noReplacementRule: { kind: "SPLIT_PERCENT", percent: 50 } }), "p1"), "p1", AFTER_DEADLINE).state;
    const r = step(s, { type: "CUTOFF_REACHED" }, CUTOFF);
    expect(ofType(r.effects, "CAPTURE")).toEqual([
      expect.objectContaining({ commitmentId: "c-p1", amountMinor: 250, rule: "CUTOFF_CAPTURE_LATE_DROPOUT_SPLIT_PERCENT" }),
    ]);
  });

  it("never captures early dropouts, replaced people, the waitlist or unfinished joins", () => {
    let s = join(join(openPlan({ spots: 3 }), "p1"), "p2");
    s = dropOut(s, "p1", BEFORE_DEADLINE).state; // DROPPED_EARLY
    s = dropOut(s, "p2", AFTER_DEADLINE).state;
    s = authorize(offerAndAccept(s, "c-p2", "w1", AFTER_DEADLINE).state, "c-w1", AFTER_DEADLINE).state; // p2 REPLACED
    s = step(s, { type: "JOIN_WAITLIST", commitmentId: "c-w2", participantId: "w2" }, AFTER_DEADLINE).state;
    s = step(s, { type: "JOIN_REQUESTED", commitmentId: "c-p3", participantId: "p3" }, AFTER_DEADLINE).state; // pending
    const r = step(s, { type: "CUTOFF_REACHED" }, CUTOFF);
    expect(ofType(r.effects, "CAPTURE").map((c) => c.commitmentId)).toEqual(["c-w1"]);
  });

  it("is idempotent: running the cutoff job twice never captures twice", () => {
    const first = step(join(openPlan(), "p1"), { type: "CUTOFF_REACHED" }, CUTOFF);
    const second = step(first.state, { type: "CUTOFF_REACHED" }, AFTER_CUTOFF);
    expect(second.noop).toBeDefined();
    expect(ofType(second.effects, "CAPTURE")).toEqual([]);
    // Also after the capture completed.
    const paid = step(first.state, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap1", amountMinor: 500 }, CUTOFF).state;
    expect(ofType(step(paid, { type: "CUTOFF_REACHED" }, AFTER_CUTOFF).effects, "CAPTURE")).toEqual([]);
  });

  describe("capture failure → CAPTURE_FAILED", () => {
    function failed(at = CUTOFF) {
      const s = step(join(join(openPlan(), "p1"), "p2"), { type: "CUTOFF_REACHED" }, CUTOFF).state;
      return step(s, { type: "CAPTURE_FAILED", commitmentId: "c-p1", reason: "DECLINED" }, at);
    }

    it("tells the participant and the organizer and offers the spot before the start", () => {
      const r = failed();
      expect(statusOf(r.state, "c-p1")).toBe("CAPTURE_FAILED");
      expect(notified(r.effects, "p1", "CHARGE_FAILED")).toBe(true);
      expect(ofType(r.effects, "NOTIFY").some((n) => n.to.kind === "organizer" && n.notice.kind === "CHARGE_FAILED")).toBe(true);
      expect(ofType(r.effects, "FIND_REPLACEMENT")).toEqual([{ type: "FIND_REPLACEMENT", spotCommitmentId: "c-p1" }]);
    });

    it("does not offer the spot once the event has started", () => {
      expect(ofType(failed(AFTER_START).effects, "FIND_REPLACEMENT")).toEqual([]);
    });

    it("lets a replacement take a failed spot before the start and captures them straight away", () => {
      const { state } = offerAndAccept(failed().state, "c-p1", "w1", AFTER_CUTOFF);
      const r = authorize(state, "c-w1", AFTER_CUTOFF);
      expect(statusOf(r.state, "c-w1")).toBe("COMMITTED");
      expect(ofType(r.effects, "CAPTURE")).toEqual([
        expect.objectContaining({ commitmentId: "c-w1", amountMinor: 500, rule: "LATE_REPLACEMENT_CAPTURE" }),
      ]);
      expect(r.state.commitments["c-p1"]).toMatchObject({ status: "REPLACED", replacedByCommitmentId: "c-w1" });
      expect(ofType(r.effects, "VOID")).toEqual([expect.objectContaining({ commitmentId: "c-p1", rule: "REPLACEMENT_VOID" })]);
      const paid = step(r.state, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-w1", captureId: "cap-w1", amountMinor: 500 }, AFTER_CUTOFF);
      expect(statusOf(paid.state, "c-w1")).toBe("PAID");
    });
  });

  it("completes the plan only after the start with no money actions in flight", () => {
    let s = step(join(openPlan(), "p1"), { type: "CUTOFF_REACHED" }, CUTOFF).state;
    expect(stepFails(s, { type: "COMPLETE_PLAN" }, AFTER_START).error.code).toBe("NOT_READY_TO_COMPLETE");
    s = step(s, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap1", amountMinor: 500 }, CUTOFF).state;
    expect(stepFails(s, { type: "COMPLETE_PLAN" }, AFTER_CUTOFF).error.code).toBe("NOT_READY_TO_COMPLETE");
    expect(step(s, { type: "COMPLETE_PLAN" }, AFTER_START).state.plan.status).toBe("COMPLETED");
  });
});

describe("plan cancelled → VOID every authorization → RELEASED_CANCELLED", () => {
  it("voids every held authorization and releases everyone", () => {
    let s = join(join(openPlan({ spots: 3 }), "p1"), "p2");
    s = dropOut(s, "p2", AFTER_DEADLINE).state; // still authorized
    s = step(s, { type: "JOIN_WAITLIST", commitmentId: "c-w1", participantId: "w1" }, AFTER_DEADLINE).state;
    s = step(s, { type: "OFFER_SENT", offerId: "o1", spotCommitmentId: "c-p2", offeredToParticipantId: "w1", expiresAt: plus(AFTER_DEADLINE, 60 * MIN) }, AFTER_DEADLINE).state;
    const r = step(s, { type: "CANCEL_PLAN", byParticipantId: "org" }, AFTER_DEADLINE);
    expect(r.state.plan.status).toBe("CANCELLED");
    expect(ofType(r.effects, "VOID")).toEqual([
      expect.objectContaining({ commitmentId: "c-p1", authorizationId: "auth-c-p1", rule: "PLAN_CANCELLED_VOID" }),
      expect.objectContaining({ commitmentId: "c-p2", authorizationId: "auth-c-p2", rule: "PLAN_CANCELLED_VOID" }),
    ]);
    for (const id of ["c-p1", "c-p2", "c-w1"]) expect(statusOf(r.state, id)).toBe("RELEASED_CANCELLED");
    expect(r.state.offers["o1"]?.status).toBe("CANCELLED");
    expect(ofType(r.effects, "CAPTURE")).toEqual([]);
  });

  it("only lets the organizer cancel", () => {
    expect(stepFails(openPlan(), { type: "CANCEL_PLAN", byParticipantId: "p1" }, OPEN_AT).error.code).toBe("NOT_ORGANIZER");
  });

  it("voids an authorization that arrives after the cancellation", () => {
    let s = step(openPlan(), { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, OPEN_AT).state;
    s = approve(s, "c-p1", OPEN_AT);
    s = step(s, { type: "CANCEL_PLAN", byParticipantId: "org" }, OPEN_AT).state;
    const r = authorize(s, "c-p1", OPEN_AT);
    expect(statusOf(r.state, "c-p1")).toBe("RELEASED_CANCELLED");
    expect(ofType(r.effects, "VOID")).toEqual([expect.objectContaining({ commitmentId: "c-p1", rule: "PLAN_CANCELLED_VOID" })]);
  });

  it("refuses cancellation after the cutoff, even when some captures failed, and moves no money", () => {
    let s = step(join(join(openPlan(), "p1"), "p2"), { type: "CUTOFF_REACHED" }, CUTOFF).state;
    s = step(s, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap1", amountMinor: 500 }, CUTOFF).state;
    s = step(s, { type: "CAPTURE_FAILED", commitmentId: "c-p2", reason: "DECLINED" }, CUTOFF).state;
    const r = stepFails(s, { type: "CANCEL_PLAN", byParticipantId: "org" }, AFTER_CUTOFF);
    expect(r.error.code).toBe("PLAN_LOCKED");
    expect(statusOf(s, "c-p1")).toBe("PAID");
    expect(statusOf(s, "c-p2")).toBe("CAPTURE_FAILED");
  });

  it("treats a second cancellation as a no-op", () => {
    const s = step(join(openPlan(), "p1"), { type: "CANCEL_PLAN", byParticipantId: "org" }, OPEN_AT).state;
    const r = step(s, { type: "CANCEL_PLAN", byParticipantId: "org" }, OPEN_AT);
    expect(r.noop).toBeDefined();
    expect(r.effects).toEqual([]);
  });
});

describe("reauthorization scheduling for long plans (single reauth, day 4 to day 29)", () => {
  const longPlan = {
    startsAt: T("2026-11-27T18:00:00Z"),
    freeDropoutDeadline: T("2026-11-25T18:00:00Z"),
    captureCutoff: T("2026-11-27T12:00:00Z"),
  };
  const JOIN_AT = T("2026-11-07T12:00:00Z"); // 20 days before the cutoff
  const REAUTH_AT = new Date(longPlan.captureCutoff.getTime() - REAUTH_LEAD_MS);

  it("schedules one reauthorization so the new honor period covers the cutoff", () => {
    let s = openPlan(longPlan);
    s = step(s, { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, JOIN_AT).state;
    const r = authorize(approve(s, "c-p1", JOIN_AT), "c-p1", JOIN_AT);
    expect(ofType(r.effects, "SCHEDULE_JOB")).toEqual([{ type: "SCHEDULE_JOB", job: { kind: "REAUTH", commitmentId: "c-p1" }, at: REAUTH_AT }]);
  });

  it("schedules nothing for short plans", () => {
    let s = step(openPlan(), { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, BEFORE_DEADLINE).state;
    const r = authorize(approve(s, "c-p1", BEFORE_DEADLINE), "c-p1", BEFORE_DEADLINE);
    expect(ofType(r.effects, "SCHEDULE_JOB")).toEqual([]);
  });

  it("refuses to reauthorize inside the honor period (PayPal: REAUTHORIZATION_TOO_SOON)", () => {
    const s = join(openPlan(longPlan), "p1", JOIN_AT);
    expect(stepFails(s, { type: "REAUTH_DUE", commitmentId: "c-p1" }, T("2026-11-09T12:00:00Z")).error.code).toBe("REAUTH_TOO_SOON");
    // Exactly 72 h is still too soon: the engine keeps a safety margin.
    expect(stepFails(s, { type: "REAUTH_DUE", commitmentId: "c-p1" }, T("2026-11-10T12:00:00Z")).error.code).toBe("REAUTH_TOO_SOON");
  });

  it("reauthorizes once, then captures against the newest authorization id", () => {
    let s = join(openPlan(longPlan), "p1", JOIN_AT);
    const due = step(s, { type: "REAUTH_DUE", commitmentId: "c-p1" }, REAUTH_AT);
    expect(ofType(due.effects, "REAUTHORIZE")).toEqual([
      { type: "REAUTHORIZE", moneyEventId: "c-p1:REAUTHORIZE:auth-c-p1", commitmentId: "c-p1", authorizationId: "auth-c-p1", amountMinor: 500, currency: "USD", rule: "HONOR_PERIOD_REAUTHORIZE" },
    ]);
    // A duplicate job run while the call is in flight does nothing.
    expect(step(due.state, { type: "REAUTH_DUE", commitmentId: "c-p1" }, REAUTH_AT).effects).toEqual([]);

    s = step(due.state, { type: "REAUTH_SUCCEEDED", commitmentId: "c-p1", newAuthorizationId: "auth-c-p1-v2" }, REAUTH_AT).state;
    expect(s.commitments["c-p1"]).toMatchObject({
      paypalAuthorizationId: "auth-c-p1-v2",
      authorizedAt: JOIN_AT, // the 29-day window still counts from the original
      reauthorizedAt: REAUTH_AT,
    });

    const second = step(s, { type: "REAUTH_DUE", commitmentId: "c-p1" }, plus(REAUTH_AT, 60 * MIN));
    expect(second.noop).toBeDefined();
    expect(ofType(second.effects, "REAUTHORIZE")).toEqual([]);

    const cutoff = step(s, { type: "CUTOFF_REACHED" }, longPlan.captureCutoff);
    expect(ofType(cutoff.effects, "CAPTURE")).toEqual([expect.objectContaining({ authorizationId: "auth-c-p1-v2" })]);
  });

  it("voids the new authorization if the person dropped out while it was being renewed", () => {
    let s = join(openPlan(longPlan), "p1", JOIN_AT);
    s = step(s, { type: "REAUTH_DUE", commitmentId: "c-p1" }, T("2026-11-20T12:00:00Z")).state;
    s = dropOut(s, "p1", T("2026-11-20T12:01:00Z")).state; // early: voids auth-c-p1
    const r = step(s, { type: "REAUTH_SUCCEEDED", commitmentId: "c-p1", newAuthorizationId: "auth-c-p1-v2" }, T("2026-11-20T12:02:00Z"));
    expect(ofType(r.effects, "VOID")).toEqual([
      expect.objectContaining({ commitmentId: "c-p1", authorizationId: "auth-c-p1-v2", rule: "EARLY_DROPOUT_VOID" }),
    ]);
  });

  describe("failed reauthorization → re-approval (8.2, 7.5)", () => {
    const RA_DEADLINE = T("2026-11-26T12:00:00Z"); // min(failure + 24 h, cutoff − 2 h)
    const failReauth = (at = REAUTH_AT) => {
      let s = join(openPlan(longPlan), "p1", JOIN_AT);
      s = step(s, { type: "REAUTH_DUE", commitmentId: "c-p1" }, at).state;
      return step(s, { type: "REAUTH_FAILED", commitmentId: "c-p1", reason: "INSTRUMENT_DECLINED" }, at);
    };
    const reapprove = (s: PlanState, at: Date) => {
      const created = step(s, { type: "ORDER_CREATED", commitmentId: "c-p1", orderId: "reorder-1" }, at).state;
      return step(created, { type: "ORDER_APPROVED", commitmentId: "c-p1", orderId: "reorder-1" }, at);
    };
    const expire = (s: PlanState) => step(s, { type: "REAPPROVAL_DEADLINE", commitmentId: "c-p1" }, RA_DEADLINE);

    it("keeps the old hold and asks the participant to re-approve within min(24 h, cutoff − 2 h)", () => {
      const r = failReauth();
      expect(r.state.commitments["c-p1"]).toMatchObject({
        status: "COMMITTED",
        paypalAuthorizationId: "auth-c-p1",
        pendingMoneyActions: [],
        reapproval: { status: "REQUESTED", requestedAt: REAUTH_AT, deadline: RA_DEADLINE },
      });
      expect(ofType(r.effects, "CREATE_ORDER")).toEqual([
        expect.objectContaining({ commitmentId: "c-p1", amountMinor: 500, purpose: "REAPPROVAL" }),
      ]);
      expect(ofType(r.effects, "SCHEDULE_JOB")).toEqual([
        { type: "SCHEDULE_JOB", job: { kind: "REAPPROVAL_DEADLINE", commitmentId: "c-p1" }, at: RA_DEADLINE },
      ]);
      expect(ofType(r.effects, "NOTIFY")).toContainEqual({
        type: "NOTIFY",
        to: { kind: "participant", participantId: "p1" },
        notice: { kind: "REAPPROVAL_NEEDED", commitmentId: "c-p1", deadline: RA_DEADLINE },
      });
      expect(ofType(r.effects, "NOTIFY").some((n) => n.to.kind === "organizer" && n.notice.kind === "HOLD_RENEWAL_FAILED")).toBe(true);
      expect(ofType(r.effects, "FLAG_ANOMALY")).toEqual([expect.objectContaining({ code: "REAUTH_FAILED" })]);
      expect(moneyEffects(r.effects)).toEqual([]);
    });

    it("caps the window at 2 h before the cutoff", () => {
      const r = failReauth(T("2026-11-26T16:00:00Z"));
      expect(r.state.commitments["c-p1"]?.reapproval?.deadline).toEqual(T("2026-11-27T10:00:00Z"));
    });

    it("goes straight to offering the spot when the window is already closed", () => {
      const r = failReauth(T("2026-11-27T11:00:00Z"));
      expect(r.state.commitments["c-p1"]).toMatchObject({ status: "COMMITTED", reapproval: { status: "EXPIRED" } });
      expect(ofType(r.effects, "CREATE_ORDER")).toEqual([]);
      expect(ofType(r.effects, "SCHEDULE_JOB")).toEqual([]);
      expect(ofType(r.effects, "FIND_REPLACEMENT")).toEqual([{ type: "FIND_REPLACEMENT", spotCommitmentId: "c-p1" }]);
      expect(notified(r.effects, "p1", "REAPPROVAL_EXPIRED")).toBe(true);
    });

    it("switches to the new authorization and only then voids the old one", () => {
      const approved = reapprove(failReauth().state, T("2026-11-25T15:00:00Z"));
      expect(ofType(approved.effects, "AUTHORIZE")).toEqual([
        expect.objectContaining({ commitmentId: "c-p1", orderId: "reorder-1", rule: "REAPPROVAL_AUTHORIZE" }),
      ]);
      expect(ofType(approved.effects, "RECORD_RULES_ACCEPTANCE")).toHaveLength(1);
      expect(ofType(approved.effects, "VOID")).toEqual([]);

      const at = T("2026-11-25T15:01:00Z");
      const r = authorize(approved.state, "c-p1", at, "auth-c-p1-new");
      const c = r.state.commitments["c-p1"];
      expect(c).toMatchObject({ status: "COMMITTED", paypalAuthorizationId: "auth-c-p1-new", authorizedAt: at, reapproval: { status: "DONE" } });
      expect(c?.reauthorizedAt).toBeUndefined();
      expect(ofType(r.effects, "VOID")).toEqual([
        { type: "VOID", moneyEventId: "c-p1:VOID:auth-c-p1", commitmentId: "c-p1", authorizationId: "auth-c-p1", rule: "REAPPROVAL_SUPERSEDED_VOID" },
      ]);
      const cutoff = step(r.state, { type: "CUTOFF_REACHED" }, longPlan.captureCutoff);
      expect(ofType(cutoff.effects, "CAPTURE")).toEqual([expect.objectContaining({ authorizationId: "auth-c-p1-new" })]);
    });

    it("keeps the old hold if PayPal refuses the new authorization, and sends a fresh link", () => {
      const approved = reapprove(failReauth().state, T("2026-11-25T15:00:00Z"));
      const r = step(approved.state, { type: "AUTHORIZATION_FAILED", commitmentId: "c-p1", reason: "INSTRUMENT_DECLINED" }, T("2026-11-25T15:01:00Z"));
      expect(r.state.commitments["c-p1"]).toMatchObject({ status: "COMMITTED", paypalAuthorizationId: "auth-c-p1", reapproval: { status: "REQUESTED" } });
      expect(r.state.commitments["c-p1"]?.reapproval?.orderId).toBeUndefined();
      expect(ofType(r.effects, "CREATE_ORDER")).toEqual([expect.objectContaining({ purpose: "REAPPROVAL" })]);
      expect(moneyEffects(r.effects)).toEqual([]);
    });

    it("offers the spot when the window passes, and the old link stops working", () => {
      let s = failReauth().state;
      s = step(s, { type: "ORDER_CREATED", commitmentId: "c-p1", orderId: "reorder-1" }, plus(REAUTH_AT, 60 * MIN)).state;
      expect(stepFails(s, { type: "REAPPROVAL_DEADLINE", commitmentId: "c-p1" }, plus(RA_DEADLINE, -1)).error.code).toBe("REAPPROVAL_NOT_DUE");
      const r = expire(s);
      expect(r.state.commitments["c-p1"]).toMatchObject({ status: "COMMITTED", paypalAuthorizationId: "auth-c-p1", reapproval: { status: "EXPIRED" } });
      expect(ofType(r.effects, "FIND_REPLACEMENT")).toEqual([{ type: "FIND_REPLACEMENT", spotCommitmentId: "c-p1" }]);
      expect(notified(r.effects, "p1", "REAPPROVAL_EXPIRED")).toBe(true);
      expect(ofType(r.effects, "NOTIFY").some((n) => n.to.kind === "organizer" && n.notice.kind === "REAPPROVAL_EXPIRED")).toBe(true);
      expect(moneyEffects(r.effects)).toEqual([]);

      const late = step(r.state, { type: "ORDER_APPROVED", commitmentId: "c-p1", orderId: "reorder-1" }, plus(RA_DEADLINE, MIN));
      expect(late.noop).toBeDefined();
      expect(ofType(late.effects, "AUTHORIZE")).toEqual([]);
    });

    it("voids the old hold if a replacement takes the spot", () => {
      const s = expire(failReauth().state).state;
      const { state } = offerAndAccept(s, "c-p1", "w1", plus(RA_DEADLINE, MIN));
      const r = authorize(state, "c-w1", plus(RA_DEADLINE, 2 * MIN));
      expect(statusOf(r.state, "c-w1")).toBe("COMMITTED");
      expect(r.state.commitments["c-p1"]).toMatchObject({ status: "REPLACED", replacedByCommitmentId: "c-w1" });
      expect(ofType(r.effects, "VOID")).toEqual([
        expect.objectContaining({ commitmentId: "c-p1", authorizationId: "auth-c-p1", rule: "REPLACEMENT_VOID" }),
      ]);
    });

    it("tries the old hold at the cutoff if nobody takes the spot, and marks CAPTURE_FAILED if that fails", () => {
      const cutoff = step(expire(failReauth().state).state, { type: "CUTOFF_REACHED" }, longPlan.captureCutoff);
      expect(ofType(cutoff.effects, "CAPTURE")).toEqual([
        expect.objectContaining({ commitmentId: "c-p1", authorizationId: "auth-c-p1", rule: "CUTOFF_CAPTURE_COMMITTED" }),
      ]);
      const failed = step(cutoff.state, { type: "CAPTURE_FAILED", commitmentId: "c-p1", reason: "DECLINED" }, longPlan.captureCutoff);
      expect(statusOf(failed.state, "c-p1")).toBe("CAPTURE_FAILED");
    });

    it("closes an open re-approval at the cutoff and captures the old hold", () => {
      const cutoff = step(failReauth().state, { type: "CUTOFF_REACHED" }, longPlan.captureCutoff);
      expect(cutoff.state.commitments["c-p1"]?.reapproval?.status).toBe("EXPIRED");
      expect(ofType(cutoff.effects, "CAPTURE")).toEqual([expect.objectContaining({ authorizationId: "auth-c-p1" })]);
    });

    it("never retries the reauthorization while re-approval is open or expired", () => {
      const s = failReauth().state;
      expect(step(s, { type: "REAUTH_DUE", commitmentId: "c-p1" }, plus(REAUTH_AT, 60 * MIN)).noop).toBeDefined();
      expect(step(expire(s).state, { type: "REAUTH_DUE", commitmentId: "c-p1" }, plus(RA_DEADLINE, MIN)).noop).toBeDefined();
    });

    it("does not close the window while the new authorization is in flight", () => {
      const approved = reapprove(failReauth().state, plus(RA_DEADLINE, -MIN));
      expect(expire(approved.state).noop).toBeDefined();
    });

    it("voids a re-approval authorization that lands after the plan was cancelled", () => {
      const approved = reapprove(failReauth().state, T("2026-11-25T15:00:00Z"));
      const cancelled = step(approved.state, { type: "CANCEL_PLAN", byParticipantId: "org" }, T("2026-11-25T15:00:30Z"));
      expect(ofType(cancelled.effects, "VOID")).toEqual([expect.objectContaining({ authorizationId: "auth-c-p1", rule: "PLAN_CANCELLED_VOID" })]);
      const r = authorize(cancelled.state, "c-p1", T("2026-11-25T15:01:00Z"), "auth-c-p1-new");
      expect(ofType(r.effects, "VOID")).toEqual([expect.objectContaining({ authorizationId: "auth-c-p1-new", rule: "PLAN_CANCELLED_VOID" })]);
      expect(statusOf(r.state, "c-p1")).toBe("RELEASED_CANCELLED");
    });
  });
});

describe("duplicate and out-of-order webhooks", () => {
  it("authorizes only once when the approval arrives twice (return page + webhook)", () => {
    let s = step(openPlan(), { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, OPEN_AT).state;
    s = approve(s, "c-p1", OPEN_AT);
    const again = step(s, { type: "ORDER_APPROVED", commitmentId: "c-p1", orderId: "order-c-p1-1" }, OPEN_AT);
    expect(again.noop).toBeDefined();
    expect(again.effects).toEqual([]);
  });

  it("rejects an approval for a different order", () => {
    let s = step(openPlan(), { type: "JOIN_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, OPEN_AT).state;
    s = step(s, { type: "ORDER_CREATED", commitmentId: "c-p1", orderId: "o1" }, OPEN_AT).state;
    expect(stepFails(s, { type: "ORDER_APPROVED", commitmentId: "c-p1", orderId: "o-other" }, OPEN_AT).error.code).toBe("ORDER_MISMATCH");
  });

  it("ignores a repeated authorization success", () => {
    const s = join(openPlan(), "p1");
    const r = authorize(s, "c-p1", OPEN_AT);
    expect(r.noop).toBeDefined();
    expect(r.effects).toEqual([]);
  });

  it("voids an unexpected second authorization without changing state", () => {
    const s = join(openPlan(), "p1");
    const r = authorize(s, "c-p1", OPEN_AT, "auth-surprise");
    expect(r.state.commitments["c-p1"]).toEqual(s.commitments["c-p1"]);
    expect(ofType(r.effects, "VOID")).toEqual([
      expect.objectContaining({ authorizationId: "auth-surprise", rule: "UNEXPECTED_AUTHORIZATION_VOID" }),
    ]);
    expect(ofType(r.effects, "FLAG_ANOMALY")).toEqual([expect.objectContaining({ code: "UNEXPECTED_AUTHORIZATION" })]);
  });

  it("clears a pending void once, and ignores the repeat", () => {
    let s = dropOut(join(openPlan(), "p1"), "p1", BEFORE_DEADLINE).state;
    expect(s.commitments["c-p1"]?.pendingMoneyActions).toHaveLength(1);
    s = step(s, { type: "VOID_SUCCEEDED", commitmentId: "c-p1", authorizationId: "auth-c-p1" }, BEFORE_DEADLINE).state;
    expect(s.commitments["c-p1"]?.pendingMoneyActions).toEqual([]);
    const again = step(s, { type: "VOID_SUCCEEDED", commitmentId: "c-p1", authorizationId: "auth-c-p1" }, BEFORE_DEADLINE);
    expect(again.noop).toBeDefined();
  });

  it("flags a void we never asked for and keeps the commitment as it was", () => {
    const s = join(openPlan(), "p1");
    const r = step(s, { type: "VOID_SUCCEEDED", commitmentId: "c-p1", authorizationId: "auth-c-p1" }, OPEN_AT);
    expect(statusOf(r.state, "c-p1")).toBe("COMMITTED");
    expect(ofType(r.effects, "FLAG_ANOMALY")).toEqual([expect.objectContaining({ code: "UNEXPECTED_VOID" })]);
  });

  it("ignores a repeated capture success", () => {
    let s = step(join(openPlan(), "p1"), { type: "CUTOFF_REACHED" }, CUTOFF).state;
    s = step(s, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap1", amountMinor: 500 }, CUTOFF).state;
    const again = step(s, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap1", amountMinor: 500 }, CUTOFF);
    expect(again.noop).toBeDefined();
    expect(again.effects).toEqual([]);
  });

  it("never moves PAID backwards when a failure arrives after the success", () => {
    let s = step(join(openPlan(), "p1"), { type: "CUTOFF_REACHED" }, CUTOFF).state;
    s = step(s, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap1", amountMinor: 500 }, CUTOFF).state;
    const r = step(s, { type: "CAPTURE_FAILED", commitmentId: "c-p1", reason: "DENIED" }, CUTOFF);
    expect(statusOf(r.state, "c-p1")).toBe("PAID");
    expect(ofType(r.effects, "FLAG_ANOMALY")).toEqual([expect.objectContaining({ code: "CAPTURE_FAILURE_AFTER_SUCCESS" })]);
    expect(moneyEffects(r.effects)).toEqual([]);
  });

  it("flags a capture we never requested", () => {
    const s = join(openPlan(), "p1");
    const r = step(s, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap-x", amountMinor: 500 }, OPEN_AT);
    expect(statusOf(r.state, "c-p1")).toBe("COMMITTED");
    expect(ofType(r.effects, "FLAG_ANOMALY")).toEqual([expect.objectContaining({ code: "UNEXPECTED_CAPTURE" })]);
  });

  it("flags a capture for a different amount than requested", () => {
    const s = step(join(openPlan(), "p1"), { type: "CUTOFF_REACHED" }, CUTOFF).state;
    const r = step(s, { type: "CAPTURE_SUCCEEDED", commitmentId: "c-p1", captureId: "cap1", amountMinor: 499 }, CUTOFF);
    expect(ofType(r.effects, "FLAG_ANOMALY")).toEqual([expect.objectContaining({ code: "CAPTURE_AMOUNT_MISMATCH" })]);
  });
});

describe("emergency release: participant asks, organizer approves, engine voids (never charges)", () => {
  const lateDropout = (plan: Partial<Plan> = {}) => dropOut(join(join(openPlan(plan), "p1"), "p2"), "p1", AFTER_DEADLINE).state;
  const request = (s: PlanState, at = AFTER_DEADLINE, participantId = "p1") =>
    step(s, { type: "EMERGENCY_RELEASE_REQUESTED", commitmentId: "c-p1", participantId, note: "family emergency" }, at);
  const decide = (s: PlanState, approved: boolean, at = AFTER_DEADLINE) =>
    step(s, { type: "EMERGENCY_RELEASE_DECIDED", commitmentId: "c-p1", byParticipantId: "org", approved }, at);

  it("asks the organizer and moves no money", () => {
    const r = request(lateDropout());
    expect(ofType(r.effects, "ASK_ORGANIZER")).toEqual([
      { type: "ASK_ORGANIZER", question: { kind: "EMERGENCY_RELEASE", commitmentId: "c-p1", participantId: "p1", note: "family emergency" } },
    ]);
    expect(r.state.commitments["c-p1"]).toMatchObject({
      status: "DROPPED_LATE_SEEKING",
      emergencyRelease: { status: "REQUESTED", requestedAt: AFTER_DEADLINE },
    });
    expect(moneyEffects(r.effects)).toEqual([]);
    expect(notified(r.effects, "p1", "EMERGENCY_RELEASE_REQUESTED")).toBe(true);
  });

  it("voids the hold when the organizer approves → RELEASED_EMERGENCY", () => {
    const r = decide(request(lateDropout()).state, true);
    expect(r.state.commitments["c-p1"]).toMatchObject({
      status: "RELEASED_EMERGENCY",
      emergencyRelease: { status: "APPROVED", decidedAt: AFTER_DEADLINE },
    });
    expect(moneyEffects(r.effects)).toEqual([
      { type: "VOID", moneyEventId: "c-p1:VOID:auth-c-p1", commitmentId: "c-p1", authorizationId: "auth-c-p1", rule: "EMERGENCY_RELEASE_VOID" },
    ]);
    expect(notified(r.effects, "p1", "EMERGENCY_RELEASED")).toBe(true);
    // Released people are never captured at the cutoff.
    expect(ofType(step(r.state, { type: "CUTOFF_REACHED" }, CUTOFF).effects, "CAPTURE").map((c) => c.commitmentId)).toEqual(["c-p2"]);
  });

  it("applies the normal rule when the organizer refuses, with no money action from the refusal itself", () => {
    const r = decide(request(lateDropout()).state, false);
    expect(r.state.commitments["c-p1"]).toMatchObject({ status: "DROPPED_LATE_SEEKING", emergencyRelease: { status: "REFUSED" } });
    expect(moneyEffects(r.effects)).toEqual([]);
    expect(notified(r.effects, "p1", "EMERGENCY_RELEASE_REFUSED")).toBe(true);
    const cutoff = step(r.state, { type: "CUTOFF_REACHED" }, CUTOFF);
    expect(ofType(cutoff.effects, "CAPTURE")).toContainEqual(
      expect.objectContaining({ commitmentId: "c-p1", amountMinor: 500, rule: "CUTOFF_CAPTURE_LATE_DROPOUT_FULL_SHARE" }),
    );
  });

  it("works with SPLIT_PERCENT too: a refusal still only charges the split", () => {
    const s = decide(request(lateDropout({ noReplacementRule: { kind: "SPLIT_PERCENT", percent: 50 } })).state, false).state;
    expect(ofType(step(s, { type: "CUTOFF_REACHED" }, CUTOFF).effects, "CAPTURE")).toContainEqual(
      expect.objectContaining({ commitmentId: "c-p1", amountMinor: 250 }),
    );
  });

  it("tells the participant when the organizer has not enabled it", () => {
    const s = lateDropout({ emergencyReleaseEnabled: false });
    const r = stepFails(s, { type: "EMERGENCY_RELEASE_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, AFTER_DEADLINE);
    expect(r.error.code).toBe("EMERGENCY_RELEASE_NOT_ENABLED");
  });

  it("needs a confirmed late dropout first (rule 5)", () => {
    const r = stepFails(lateDropout(), { type: "EMERGENCY_RELEASE_REQUESTED", commitmentId: "c-p2", participantId: "p2" }, AFTER_DEADLINE);
    expect(r.error.code).toBe("NOT_DROPPED_LATE");
  });

  it("only lets people ask for themselves, and only the organizer decide", () => {
    expect(
      stepFails(lateDropout(), { type: "EMERGENCY_RELEASE_REQUESTED", commitmentId: "c-p1", participantId: "p2" }, AFTER_DEADLINE).error.code,
    ).toBe("NOT_YOUR_COMMITMENT");
    const s = request(lateDropout()).state;
    for (const by of ["p2", "p1"]) {
      expect(
        stepFails(s, { type: "EMERGENCY_RELEASE_DECIDED", commitmentId: "c-p1", byParticipantId: by, approved: true }, AFTER_DEADLINE).error.code,
      ).toBe("NOT_ORGANIZER");
    }
  });

  it("refuses a decision nobody asked for", () => {
    const r = stepFails(lateDropout(), { type: "EMERGENCY_RELEASE_DECIDED", commitmentId: "c-p1", byParticipantId: "org", approved: true }, AFTER_DEADLINE);
    expect(r.error.code).toBe("NO_PENDING_REQUEST");
  });

  it("treats repeats as no-ops and never flips a decision", () => {
    let s = request(lateDropout()).state;
    expect(request(s).noop).toBeDefined();
    s = decide(s, false).state;
    expect(decide(s, false).noop).toBeDefined();
    expect(
      stepFails(s, { type: "EMERGENCY_RELEASE_DECIDED", commitmentId: "c-p1", byParticipantId: "org", approved: true }, AFTER_DEADLINE).error.code,
    ).toBe("ALREADY_DECIDED");
    expect(stepFails(s, { type: "EMERGENCY_RELEASE_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, AFTER_DEADLINE).error.code).toBe(
      "ALREADY_DECIDED",
    );
    const approved = decide(request(lateDropout()).state, true).state;
    const again = decide(approved, true);
    expect(again.noop).toBeDefined();
    expect(again.effects).toEqual([]);
  });

  it("is too late once the cutoff has passed: the pending request expires and the normal rule applies", () => {
    const s = request(lateDropout()).state;
    const cutoff = step(s, { type: "CUTOFF_REACHED" }, CUTOFF);
    expect(ofType(cutoff.effects, "CAPTURE")).toContainEqual(expect.objectContaining({ commitmentId: "c-p1", amountMinor: 500 }));
    expect(cutoff.state.commitments["c-p1"]?.emergencyRelease?.status).toBe("EXPIRED");
    const late = stepFails(cutoff.state, { type: "EMERGENCY_RELEASE_DECIDED", commitmentId: "c-p1", byParticipantId: "org", approved: true }, AFTER_CUTOFF);
    expect(late.error.code).toBe("RELEASE_TOO_LATE");
    expect(stepFails(lateDropout(), { type: "EMERGENCY_RELEASE_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, CUTOFF).error.code).toBe(
      "RELEASE_TOO_LATE",
    );
  });

  it("keeps the spot open after a release; a replacement fills it without another void", () => {
    const released = decide(request(lateDropout()).state, true).state;
    const { state } = offerAndAccept(released, "c-p1", "w1", AFTER_DEADLINE);
    const r = authorize(state, "c-w1", AFTER_DEADLINE);
    expect(statusOf(r.state, "c-w1")).toBe("COMMITTED");
    expect(r.state.commitments["c-p1"]).toMatchObject({ status: "RELEASED_EMERGENCY", replacedByCommitmentId: "c-w1" });
    expect(ofType(r.effects, "VOID")).toEqual([]);
  });

  it("does nothing if a replacement already released them before the organizer answered", () => {
    let s = request(lateDropout()).state;
    s = authorize(offerAndAccept(s, "c-p1", "w1", AFTER_DEADLINE).state, "c-w1", AFTER_DEADLINE).state;
    expect(statusOf(s, "c-p1")).toBe("REPLACED");
    const r = decide(s, true);
    expect(r.noop).toBeDefined();
    expect(moneyEffects(r.effects)).toEqual([]);
  });

  it("also releases a hold that was renewed while the organizer was deciding", () => {
    const longPlan = {
      startsAt: T("2026-11-27T18:00:00Z"),
      freeDropoutDeadline: T("2026-11-25T18:00:00Z"),
      captureCutoff: T("2026-11-27T12:00:00Z"),
    };
    let s = join(openPlan(longPlan), "p1", T("2026-11-07T12:00:00Z"));
    const at = T("2026-11-26T12:00:00Z");
    s = step(s, { type: "REAUTH_DUE", commitmentId: "c-p1" }, T("2026-11-25T12:00:00Z")).state;
    s = dropOut(s, "p1", at).state;
    s = step(s, { type: "EMERGENCY_RELEASE_REQUESTED", commitmentId: "c-p1", participantId: "p1" }, at).state;
    s = step(s, { type: "EMERGENCY_RELEASE_DECIDED", commitmentId: "c-p1", byParticipantId: "org", approved: true }, at).state;
    const r = step(s, { type: "REAUTH_SUCCEEDED", commitmentId: "c-p1", newAuthorizationId: "auth-c-p1-v2" }, at);
    expect(ofType(r.effects, "VOID")).toEqual([
      expect.objectContaining({ authorizationId: "auth-c-p1-v2", rule: "EMERGENCY_RELEASE_VOID" }),
    ]);
  });
});

// Runs last: checks rules 3, 4 and 9 across every transition made in this file.
describe("invariants across every scenario above", () => {
  it("tells the affected participant about every void, reauthorization and capture (rule 4)", () => {
    for (const effects of allResults) {
      for (const m of effects) {
        if (m.type !== "VOID" && m.type !== "REAUTHORIZE" && m.type !== "CAPTURE") continue;
        const told = ofType(effects, "NOTIFY").some((n) => n.to.kind === "participant" && n.notice.commitmentId === m.commitmentId);
        expect(told, `${m.type} on ${m.commitmentId} without a notice`).toBe(true);
      }
    }
  });

  it("never captures more than one share and only ever in integer minor units (rules 3 and 9)", () => {
    const captures = allResults.flatMap((e) => ofType(e, "CAPTURE"));
    expect(captures.length).toBeGreaterThan(0);
    for (const c of captures) {
      expect(Number.isSafeInteger(c.amountMinor)).toBe(true);
      expect(c.amountMinor).toBeGreaterThan(0);
      expect(c.amountMinor).toBeLessThanOrEqual(500);
    }
  });

  it("gives every money action a rule and a deterministic money event id", () => {
    for (const m of allResults.flatMap(moneyEffects)) {
      expect(m.rule).toBeTruthy();
      expect(m.moneyEventId).toMatch(new RegExp(`^${m.commitmentId}:${m.type}:`));
    }
  });
});
