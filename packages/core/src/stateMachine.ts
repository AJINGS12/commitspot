/**
 * The CommitSpot rules engine (CLAUDE.md sections 7 and 12).
 *
 * `transition(state, event, now)` is pure: it never reads the clock, never does I/O and
 * never mutates its input. It returns the next state plus a list of effects (PayPal calls,
 * notices, jobs) for the executor in apps/server to perform.
 *
 * Money safety built in here:
 * - every money effect carries the rule that triggered it and a deterministic money event id
 *   (`<commitmentId>:<ACTION>:<paypal id>`), usable as the PayPal-Request-Id;
 * - every void, reauthorization and capture comes with a notice to the affected participant;
 * - captures never exceed the participant's own share;
 * - repeated or out-of-order events are no-ops or anomaly flags, never backwards moves.
 */
import { isLateDropout, joinOpensAt, lateDropoutChargeMinor, planWarnings, rulesSnapshot, validatePlanRules } from "./rules.js";
import { AUTHORIZATION_VALIDITY_MS, earliestReauthorization, planReauthorization, reapprovalDeadline } from "./reauth.js";
import type {
  AnomalyCode,
  Audience,
  Commitment,
  CommitmentStatus,
  Effect,
  MoneyAction,
  Notice,
  NoticeKind,
  Offer,
  PendingMoneyAction,
  Plan,
  PlanEvent,
  PlanState,
  RuleApplied,
  TransitionErrorCode,
  TransitionResult,
} from "./types.js";

/** A dropout confirmation older than this is asked again. */
export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

/** Statuses whose PayPal authorization is still held (money state "authorized"). */
const HOLDS_AUTHORIZATION: ReadonlySet<CommitmentStatus> = new Set(["COMMITTED", "DROPPED_LATE_SEEKING"]);
/** Statuses that occupy one of the plan's spots before the cutoff. */
const HOLDS_SPOT = HOLDS_AUTHORIZATION;
/** People in these statuses cannot be offered or take another spot. */
const HAS_A_PLACE: ReadonlySet<CommitmentStatus> = new Set(["COMMITTED", "DROPPED_LATE_SEEKING", "PAID", "CAPTURE_FAILED"]);
/** Commitments that still count as "this person is in the plan" for duplicate joins. */
const ACTIVE: ReadonlySet<CommitmentStatus> = new Set(["PENDING_APPROVAL", "COMMITTED", "WAITLISTED", "DROPPED_LATE_SEEKING"]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const fail = (code: TransitionErrorCode, message: string): TransitionResult => ({ ok: false, error: { code, message } });
const noop = (state: PlanState, reason: string): TransitionResult => ({ ok: true, state, effects: [], noop: reason });

function without<T extends object, K extends keyof T>(obj: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...obj };
  for (const k of keys) delete copy[k];
  return copy;
}

const findPending = (c: Commitment, action: MoneyAction) => c.pendingMoneyActions.find((p) => p.action === action);
const hasPending = (c: Commitment, action: MoneyAction) => findPending(c, action) !== undefined;
const removePending = (c: Commitment, p: PendingMoneyAction): Commitment => ({
  ...c,
  pendingMoneyActions: c.pendingMoneyActions.filter((x) => x !== p),
});
const addPending = (c: Commitment, p: PendingMoneyAction): Commitment => ({
  ...c,
  pendingMoneyActions: [...c.pendingMoneyActions, p],
});
const moneyEventId = (commitmentId: string, action: MoneyAction, ref: string) => `${commitmentId}:${action}:${ref}`;

/** Working copy of the state for one transition. Objects are replaced, never mutated. */
class Tx {
  plan: Plan;
  readonly commitments: Record<string, Commitment>;
  readonly offers: Record<string, Offer>;
  readonly effects: Effect[] = [];

  constructor(
    readonly original: PlanState,
    readonly now: Date,
  ) {
    this.plan = original.plan;
    this.commitments = { ...original.commitments };
    this.offers = { ...original.offers };
  }

  done(): TransitionResult {
    return {
      ok: true,
      state: { plan: this.plan, commitments: this.commitments, offers: this.offers },
      effects: this.effects,
    };
  }

  get t(): number {
    return this.now.getTime();
  }

  put(c: Commitment): void {
    this.commitments[c.id] = c;
  }

  putOffer(o: Offer): void {
    this.offers[o.id] = o;
  }

  list(): Commitment[] {
    return Object.values(this.commitments);
  }

  ofParticipant(participantId: string): Commitment[] {
    return this.list().filter((c) => c.participantId === participantId);
  }

  availableSpots(): number {
    return this.plan.spots - this.list().filter((c) => HOLDS_SPOT.has(c.status)).length;
  }

  emit(...effects: Effect[]): void {
    this.effects.push(...effects);
  }

  notify(to: Audience, notice: Notice): void {
    this.emit({ type: "NOTIFY", to, notice });
  }

  tell(c: Commitment, kind: NoticeKind, extra: Omit<Notice, "kind" | "commitmentId"> = {}): void {
    this.notify({ kind: "participant", participantId: c.participantId }, { kind, commitmentId: c.id, ...extra });
  }

  tellOrganizer(c: Commitment, kind: NoticeKind): void {
    this.notify({ kind: "organizer" }, { kind, commitmentId: c.id });
  }

  flag(code: AnomalyCode, detail: string, commitmentId?: string): void {
    this.emit(commitmentId === undefined ? { type: "FLAG_ANOMALY", code, detail } : { type: "FLAG_ANOMALY", code, detail, commitmentId });
  }

  createOrder(c: Commitment, purpose: "JOIN" | "REAPPROVAL" = "JOIN"): void {
    this.emit({
      type: "CREATE_ORDER",
      commitmentId: c.id,
      amountMinor: c.amountMinor,
      currency: this.plan.currency,
      description: `CommitSpot: ${this.plan.title}`,
      purpose,
    });
  }

  /** Plan open and before the cutoff: holds can still change. */
  get beforeCutoff(): boolean {
    return this.plan.status === "OPEN" && this.t < this.plan.captureCutoff.getTime();
  }

  /** Request a void, tell the participant, and track it as pending on the returned commitment. */
  void(c: Commitment, authorizationId: string, rule: RuleApplied, notice: NoticeKind): Commitment {
    const id = moneyEventId(c.id, "VOID", authorizationId);
    this.emit({ type: "VOID", moneyEventId: id, commitmentId: c.id, authorizationId, rule });
    this.tell(c, notice, { rule });
    return addPending(c, { moneyEventId: id, action: "VOID", rule, authorizationId });
  }

  capture(c: Commitment, authorizationId: string, amountMinor: number, rule: RuleApplied): Commitment {
    // Rule 3: never more than the person's own share.
    const amount = Math.min(amountMinor, c.amountMinor);
    const id = moneyEventId(c.id, "CAPTURE", authorizationId);
    this.emit({
      type: "CAPTURE",
      moneyEventId: id,
      commitmentId: c.id,
      authorizationId,
      amountMinor: amount,
      currency: this.plan.currency,
      finalCapture: true,
      rule,
    });
    this.tell(c, "CHARGING", { amountMinor: amount, currency: this.plan.currency, rule });
    return addPending(c, { moneyEventId: id, action: "CAPTURE", rule, authorizationId, amountMinor: amount });
  }

  cancelOpenOffersFor(spotCommitmentId: string): void {
    for (const o of Object.values(this.offers)) {
      if (o.spotCommitmentId === spotCommitmentId && o.status === "OPEN") this.putOffer({ ...o, status: "CANCELLED" });
    }
  }

  /** Is this spot open for a replacement right now? */
  spotNeedsFilling(spot: Commitment): boolean {
    const { status } = this.plan;
    const beforeCutoff = status === "OPEN" && this.t < this.plan.captureCutoff.getTime();
    switch (spot.status) {
      case "DROPPED_LATE_SEEKING":
        return beforeCutoff;
      case "COMMITTED":
        // Reauthorization failed and they did not re-approve in time.
        return beforeCutoff && spot.reapproval?.status === "EXPIRED" && !spot.replacedByCommitmentId;
      case "DROPPED_EARLY":
      case "RELEASED_EMERGENCY":
        return beforeCutoff && !spot.replacedByCommitmentId && this.availableSpots() > 0;
      case "CAPTURE_FAILED":
        return (status === "OPEN" || status === "LOCKED") && !spot.replacedByCommitmentId && this.t < this.plan.startsAt.getTime();
      default:
        return false;
    }
  }

  /** Last moment an offer for this spot can be accepted. */
  offerClosesAt(spot: Commitment): Date {
    return spot.status === "CAPTURE_FAILED" ? this.plan.startsAt : this.plan.captureCutoff;
  }

  /** May a new authorization for this commitment still be placed / kept? */
  canStillAuthorize(c: Commitment): boolean {
    if (this.plan.status === "OPEN" && this.t < this.plan.captureCutoff.getTime()) return true;
    // After the cutoff, only a replacement for a failed capture, before the start.
    const orig = c.replacesCommitmentId ? this.commitments[c.replacesCommitmentId] : undefined;
    return orig !== undefined && orig.status === "CAPTURE_FAILED" && this.spotNeedsFilling(orig);
  }

  scheduleReauth(c: Commitment): void {
    const plan = planReauthorization({ authorizedAt: this.now, captureCutoff: this.plan.captureCutoff });
    if (plan.kind === "SCHEDULE") {
      this.emit({ type: "SCHEDULE_JOB", job: { kind: "REAUTH", commitmentId: c.id }, at: plan.at });
    } else if (plan.kind === "NOT_POSSIBLE") {
      this.flag("REAUTH_NOT_POSSIBLE", `Cannot keep the authorization valid until the cutoff: ${plan.reason}`, c.id);
    }
  }

  /** Reset a waitlist entry or failed attempt for a new PayPal attempt. */
  freshAttempt(c: Commitment, replacesCommitmentId?: string): Commitment {
    const base = without(
      c,
      "paypalOrderId",
      "paypalAuthorizationId",
      "authorizedAt",
      "reauthorizedAt",
      "replacesCommitmentId",
      "pendingConfirmation",
    );
    const next: Commitment = { ...base, status: "PENDING_APPROVAL", amountMinor: this.plan.pricePerSpotMinor };
    return replacesCommitmentId === undefined ? next : { ...next, replacesCommitmentId };
  }

  newCommitment(id: string, participantId: string, status: CommitmentStatus): Commitment {
    return {
      id,
      planId: this.plan.id,
      participantId,
      status,
      amountMinor: this.plan.pricePerSpotMinor,
      createdAt: this.now,
      pendingMoneyActions: [],
    };
  }
}

// ---------------------------------------------------------------------------
// Transition
// ---------------------------------------------------------------------------

export function transition(state: PlanState, event: PlanEvent, now: Date): TransitionResult {
  const tx = new Tx(state, now);
  switch (event.type) {
    case "OPEN_PLAN":
      return openPlan(tx, event);
    case "CANCEL_PLAN":
      return cancelPlan(tx, event);
    case "JOIN_REQUESTED":
      return joinRequested(tx, event);
    case "JOIN_WAITLIST":
      return joinWaitlist(tx, event);
    case "ORDER_CREATED":
      return orderCreated(tx, event);
    case "ORDER_APPROVED":
      return orderApproved(tx, event);
    case "AUTHORIZATION_SUCCEEDED":
      return authorizationSucceeded(tx, event);
    case "AUTHORIZATION_FAILED":
      return authorizationFailed(tx, event);
    case "DROPOUT_REQUESTED":
      return dropoutRequested(tx, event);
    case "DROPOUT_CONFIRMED":
      return dropoutConfirmed(tx, event);
    case "DROPOUT_DECLINED":
      return dropoutDeclined(tx, event);
    case "EMERGENCY_RELEASE_REQUESTED":
      return emergencyReleaseRequested(tx, event);
    case "EMERGENCY_RELEASE_DECIDED":
      return emergencyReleaseDecided(tx, event);
    case "OFFER_SENT":
      return offerSent(tx, event);
    case "OFFER_ACCEPTED":
      return offerAccepted(tx, event);
    case "OFFER_DECLINED":
      return offerDeclined(tx, event);
    case "OFFER_EXPIRED":
      return offerExpired(tx, event);
    case "REAUTH_DUE":
      return reauthDue(tx, event);
    case "REAUTH_SUCCEEDED":
      return reauthSucceeded(tx, event);
    case "REAUTH_FAILED":
      return reauthFailed(tx, event);
    case "REAPPROVAL_DEADLINE":
      return reapprovalDeadlineReached(tx, event);
    case "VOID_SUCCEEDED":
      return voidSucceeded(tx, event);
    case "VOID_FAILED":
      return voidFailed(tx, event);
    case "CUTOFF_REACHED":
      return cutoffReached(tx);
    case "CAPTURE_SUCCEEDED":
      return captureSucceeded(tx, event);
    case "CAPTURE_FAILED":
      return captureFailed(tx, event);
    case "COMPLETE_PLAN":
      return completePlan(tx);
  }
}

type E<K extends PlanEvent["type"]> = Extract<PlanEvent, { type: K }>;

function getCommitment(tx: Tx, id: string): Commitment | TransitionResult {
  return tx.commitments[id] ?? fail("UNKNOWN_COMMITMENT", `No commitment ${id}`);
}
const isResult = (x: Commitment | Offer | TransitionResult): x is TransitionResult => "ok" in x;

// --- Plan lifecycle ---------------------------------------------------------

function openPlan(tx: Tx, e: E<"OPEN_PLAN">): TransitionResult {
  if (e.byParticipantId !== tx.plan.organizerId) return fail("NOT_ORGANIZER", "Only the organizer can open the plan.");
  if (tx.plan.status === "OPEN") return noop(tx.original, "already open");
  if (tx.plan.status !== "DRAFT") return fail("INVALID_PLAN_STATUS", `Cannot open a ${tx.plan.status} plan.`);
  const rules = validatePlanRules(tx.plan, tx.now);
  if (!rules.ok) return fail("RULES_INVALID", rules.error.map((v) => `${v.code}: ${v.message}`).join(" "));

  tx.plan = { ...tx.plan, status: "OPEN" };
  tx.emit({ type: "SCHEDULE_JOB", job: { kind: "CUTOFF", planId: tx.plan.id }, at: tx.plan.captureCutoff });
  tx.notify({ kind: "group" }, { kind: "PLAN_OPENED" });
  for (const w of planWarnings(tx.plan, tx.now)) tx.notify({ kind: "organizer" }, { kind: w.code });
  return tx.done();
}

function cancelPlan(tx: Tx, e: E<"CANCEL_PLAN">): TransitionResult {
  if (e.byParticipantId !== tx.plan.organizerId) return fail("NOT_ORGANIZER", "Only the organizer can cancel the plan.");
  if (tx.plan.status === "CANCELLED") return noop(tx.original, "already cancelled");
  if (tx.plan.status !== "DRAFT" && tx.plan.status !== "OPEN") {
    return fail("PLAN_LOCKED", "Captures have started; cancelling now would need refunds, which are not supported.");
  }

  tx.plan = { ...tx.plan, status: "CANCELLED" };
  for (const c of tx.list()) {
    if (HOLDS_AUTHORIZATION.has(c.status)) {
      const released: Commitment = { ...without(c, "pendingConfirmation"), status: "RELEASED_CANCELLED" };
      if (c.paypalAuthorizationId) {
        tx.put(tx.void(released, c.paypalAuthorizationId, "PLAN_CANCELLED_VOID", "HOLD_RELEASED"));
      } else {
        tx.put(released);
        tx.flag("MISSING_AUTHORIZATION", `${c.status} commitment has no authorization id`, c.id);
      }
    } else if (c.status === "PENDING_APPROVAL" || c.status === "WAITLISTED") {
      // A pending AUTHORIZE stays tracked; if it lands later it is voided.
      tx.put({ ...c, status: "RELEASED_CANCELLED" });
      tx.tell(c, "PLAN_CANCELLED");
    }
  }
  for (const o of Object.values(tx.offers)) if (o.status === "OPEN") tx.putOffer({ ...o, status: "CANCELLED" });
  tx.notify({ kind: "group" }, { kind: "PLAN_CANCELLED" });
  return tx.done();
}

function completePlan(tx: Tx): TransitionResult {
  const inFlight = tx.list().some((c) => c.pendingMoneyActions.length > 0);
  if (tx.plan.status !== "LOCKED" || tx.t < tx.plan.startsAt.getTime() || inFlight) {
    return fail("NOT_READY_TO_COMPLETE", "A plan completes after its start, once locked and with no money actions in flight.");
  }
  tx.plan = { ...tx.plan, status: "COMPLETED" };
  return tx.done();
}

// --- Joining ----------------------------------------------------------------

function joinRequested(tx: Tx, e: E<"JOIN_REQUESTED">): TransitionResult {
  if (tx.plan.status === "LOCKED" || tx.t >= tx.plan.captureCutoff.getTime()) return fail("JOIN_CLOSED", "Joining closed at the cutoff.");
  if (tx.plan.status !== "OPEN") return fail("PLAN_NOT_OPEN", `The plan is ${tx.plan.status}.`);
  if (tx.t < joinOpensAt(tx.plan).getTime()) {
    return fail("JOIN_NOT_YET_OPEN", `Joining opens at ${joinOpensAt(tx.plan).toISOString()}.`);
  }

  const mine = tx.ofParticipant(e.participantId).filter((c) => ACTIVE.has(c.status));
  const reusable = mine.find(
    (c) => c.status === "WAITLISTED" || (c.status === "PENDING_APPROVAL" && !hasPending(c, "AUTHORIZE")),
  );
  if (mine.some((c) => c !== reusable)) return fail("ALREADY_JOINED", "You are already in this plan.");

  // A retry of an offer acceptance keeps its link to the spot it is filling.
  const replaces = reusable?.status === "PENDING_APPROVAL" ? reusable.replacesCommitmentId : undefined;
  const spot = replaces ? tx.commitments[replaces] : undefined;
  if (spot) {
    if (!tx.spotNeedsFilling(spot)) return fail("SPOT_NOT_OPEN", "That spot has been filled.");
  } else if (tx.availableSpots() <= 0) {
    return fail("PLAN_FULL", "All spots are taken. Join the waitlist instead.");
  }

  let c: Commitment;
  if (reusable) {
    c = tx.freshAttempt(reusable, replaces);
  } else {
    if (tx.commitments[e.commitmentId]) return fail("DUPLICATE_ID", `Commitment ${e.commitmentId} already exists.`);
    c = tx.newCommitment(e.commitmentId, e.participantId, "PENDING_APPROVAL");
  }
  tx.put(c);
  tx.createOrder(c);
  return tx.done();
}

function joinWaitlist(tx: Tx, e: E<"JOIN_WAITLIST">): TransitionResult {
  if (tx.plan.status !== "OPEN" || tx.t >= tx.plan.captureCutoff.getTime()) return fail("PLAN_NOT_OPEN", "The waitlist is closed.");
  if (tx.ofParticipant(e.participantId).some((c) => ACTIVE.has(c.status))) return fail("ALREADY_JOINED", "You are already in this plan.");
  if (tx.commitments[e.commitmentId]) return fail("DUPLICATE_ID", `Commitment ${e.commitmentId} already exists.`);
  const c = tx.newCommitment(e.commitmentId, e.participantId, "WAITLISTED");
  tx.put(c);
  tx.tell(c, "WAITLISTED");
  return tx.done();
}

function orderCreated(tx: Tx, e: E<"ORDER_CREATED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  const ra = c.reapproval;
  if (ra?.status === "REQUESTED" && HOLDS_AUTHORIZATION.has(c.status)) {
    // New order for the re-approval link. The original order and hold stay as a fallback.
    if (ra.orderId === e.orderId) return noop(tx.original, "re-approval order already recorded");
    if (ra.orderId) return fail("ORDER_MISMATCH", "This re-approval already has a different order.");
    tx.put({ ...c, reapproval: { ...ra, orderId: e.orderId } });
    return tx.done();
  }
  if (c.paypalOrderId === e.orderId) return noop(tx.original, "order already recorded");
  if (c.status !== "PENDING_APPROVAL") return noop(tx.original, `commitment is ${c.status}`);
  if (c.paypalOrderId) return fail("ORDER_MISMATCH", "This commitment already has a different order.");
  tx.put({ ...c, paypalOrderId: e.orderId });
  return tx.done();
}

function orderApproved(tx: Tx, e: E<"ORDER_APPROVED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  const ra = c.reapproval;
  if (ra?.orderId === e.orderId) {
    const open = ra.status === "REQUESTED" && tx.t < ra.deadline.getTime() && HOLDS_AUTHORIZATION.has(c.status) && tx.beforeCutoff;
    if (!open || hasPending(c, "AUTHORIZE")) return noop(tx.original, "re-approval closed or already authorizing");
    const id = moneyEventId(c.id, "AUTHORIZE", e.orderId);
    tx.emit(
      { type: "RECORD_RULES_ACCEPTANCE", acceptance: { commitmentId: c.id, rulesSnapshot: rulesSnapshot(tx.plan), acceptedAt: tx.now } },
      { type: "AUTHORIZE", moneyEventId: id, commitmentId: c.id, orderId: e.orderId, rule: "REAPPROVAL_AUTHORIZE" },
    );
    tx.put(addPending(c, { moneyEventId: id, action: "AUTHORIZE", rule: "REAPPROVAL_AUTHORIZE", orderId: e.orderId }));
    return tx.done();
  }
  if (c.paypalOrderId !== e.orderId) return fail("ORDER_MISMATCH", "Approval is for a different order.");
  if (c.status !== "PENDING_APPROVAL" || hasPending(c, "AUTHORIZE")) return noop(tx.original, "already authorizing or no longer pending");

  if (!tx.canStillAuthorize(c)) {
    tx.put({ ...c, status: "WAITLISTED" });
    tx.tell(c, "JOIN_TOO_LATE");
    return tx.done();
  }

  const id = moneyEventId(c.id, "AUTHORIZE", e.orderId);
  tx.emit(
    { type: "RECORD_RULES_ACCEPTANCE", acceptance: { commitmentId: c.id, rulesSnapshot: rulesSnapshot(tx.plan), acceptedAt: tx.now } },
    { type: "AUTHORIZE", moneyEventId: id, commitmentId: c.id, orderId: e.orderId, rule: "JOIN_APPROVED_AUTHORIZE" },
  );
  tx.put(addPending(c, { moneyEventId: id, action: "AUTHORIZE", rule: "JOIN_APPROVED_AUTHORIZE", orderId: e.orderId }));
  return tx.done();
}

function authorizationSucceeded(tx: Tx, e: E<"AUTHORIZATION_SUCCEEDED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  const authId = e.authorizationId;
  if (c.paypalAuthorizationId === authId || c.pendingMoneyActions.some((p) => p.authorizationId === authId)) {
    return noop(tx.original, "authorization already recorded");
  }

  const pending = findPending(c, "AUTHORIZE");
  if (!pending) {
    // Not something we asked for: release it, leave the commitment as it is.
    tx.void(c, authId, "UNEXPECTED_AUTHORIZATION_VOID", "HOLD_RELEASED");
    tx.flag("UNEXPECTED_AUTHORIZATION", `Authorization ${authId} arrived without a pending authorize`, c.id);
    return tx.done();
  }

  if (pending.rule === "REAPPROVAL_AUTHORIZE") return reapprovalAuthorized(tx, c, pending, authId);

  const authorized: Commitment = { ...removePending(c, pending), paypalAuthorizationId: authId, authorizedAt: tx.now };

  if (tx.plan.status === "CANCELLED" || c.status === "RELEASED_CANCELLED") {
    tx.put(tx.void({ ...authorized, status: "RELEASED_CANCELLED" }, authId, "PLAN_CANCELLED_VOID", "PLAN_CANCELLED"));
    return tx.done();
  }
  if (!tx.canStillAuthorize(c)) {
    tx.put(tx.void({ ...authorized, status: "WAITLISTED" }, authId, "LATE_AUTHORIZATION_VOID", "JOIN_TOO_LATE"));
    return tx.done();
  }

  const spotTaken = () => {
    tx.put(tx.void({ ...authorized, status: "WAITLISTED" }, authId, "SPOT_TAKEN_VOID", "SPOT_TAKEN"));
    return tx.done();
  };
  const commit = (): Commitment => {
    const committed: Commitment = { ...authorized, status: "COMMITTED" };
    tx.tell(committed, "LOCKED_IN", { amountMinor: committed.amountMinor, currency: tx.plan.currency });
    return committed;
  };

  const orig = c.replacesCommitmentId ? tx.commitments[c.replacesCommitmentId] : undefined;
  if (!orig) {
    if (tx.availableSpots() <= 0) return spotTaken();
    const committed = commit();
    tx.put(committed);
    tx.scheduleReauth(committed);
    return tx.done();
  }

  const stillHeldButOffered =
    orig.status === "DROPPED_LATE_SEEKING" ||
    (orig.status === "COMMITTED" && orig.reapproval?.status === "EXPIRED" && !orig.replacedByCommitmentId) ||
    (orig.status === "CAPTURE_FAILED" && !orig.replacedByCommitmentId);
  if (stillHeldButOffered) {
    // Replacement is authorized: only now release the original (7.4).
    let committed = commit();
    let replaced: Commitment = { ...orig, status: "REPLACED", replacedByCommitmentId: c.id };
    if (orig.paypalAuthorizationId) {
      replaced = tx.void(replaced, orig.paypalAuthorizationId, "REPLACEMENT_VOID", "REPLACED");
    } else {
      tx.tell(replaced, "REPLACED");
    }
    if (orig.status === "CAPTURE_FAILED") {
      // The cutoff has passed, so the replacement pays straight away.
      committed = tx.capture(committed, authId, committed.amountMinor, "LATE_REPLACEMENT_CAPTURE");
    } else {
      tx.scheduleReauth(committed);
    }
    tx.put(committed);
    tx.put(replaced);
    tx.cancelOpenOffersFor(orig.id);
    tx.tellOrganizer(committed, "REPLACEMENT_JOINED");
    return tx.done();
  }

  // Spots whose hold is already voided: nothing more to release.
  if ((orig.status === "DROPPED_EARLY" || orig.status === "RELEASED_EMERGENCY") && !orig.replacedByCommitmentId && tx.availableSpots() > 0) {
    const committed = commit();
    tx.put(committed);
    tx.put({ ...orig, replacedByCommitmentId: c.id });
    tx.scheduleReauth(committed);
    tx.cancelOpenOffersFor(orig.id);
    tx.tellOrganizer(committed, "REPLACEMENT_JOINED");
    return tx.done();
  }

  return spotTaken();
}

/** A re-approval authorization landed: switch to it, and only now void the old hold. */
function reapprovalAuthorized(tx: Tx, c: Commitment, pending: PendingMoneyAction, authId: string): TransitionResult {
  const next = removePending(c, pending);
  const stillHolding = HOLDS_AUTHORIZATION.has(c.status) && tx.beforeCutoff && !hasPending(c, "CAPTURE");
  if (!stillHolding) {
    // Cancelled, replaced, dropped or past the cutoff while PayPal was authorizing.
    tx.put(tx.void(next, authId, RELEASE_RULE[c.status] ?? "LATE_AUTHORIZATION_VOID", "HOLD_RELEASED"));
    return tx.done();
  }
  const oldId = c.paypalAuthorizationId;
  // A brand-new authorization: its 29-day window and single reauthorization start fresh.
  let switched: Commitment = { ...without(next, "reauthorizedAt"), paypalAuthorizationId: authId, authorizedAt: tx.now };
  if (c.reapproval) switched = { ...switched, reapproval: { ...c.reapproval, status: "DONE" } };
  if (oldId) {
    switched = tx.void(switched, oldId, "REAPPROVAL_SUPERSEDED_VOID", "HOLD_RENEWED");
  } else {
    tx.tell(switched, "HOLD_RENEWED");
  }
  tx.put(switched);
  tx.cancelOpenOffersFor(c.id);
  tx.scheduleReauth(switched);
  return tx.done();
}

function authorizationFailed(tx: Tx, e: E<"AUTHORIZATION_FAILED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  const pending = findPending(c, "AUTHORIZE");
  if (!pending) return noop(tx.original, "no authorization in flight");
  if (pending.rule === "REAPPROVAL_AUTHORIZE") {
    // The old hold is untouched. Send a fresh link if the window is still open.
    const ra = c.reapproval;
    const next: Commitment = ra ? { ...removePending(c, pending), reapproval: without(ra, "orderId") } : removePending(c, pending);
    tx.put(next);
    tx.tell(c, "AUTHORIZATION_FAILED");
    if (ra?.status === "REQUESTED" && tx.t < ra.deadline.getTime() && HOLDS_AUTHORIZATION.has(c.status) && tx.beforeCutoff) {
      tx.createOrder(next, "REAPPROVAL");
    }
    return tx.done();
  }
  // Drop the order so a retry creates a fresh one.
  tx.put(without(removePending(c, pending), "paypalOrderId"));
  tx.tell(c, "AUTHORIZATION_FAILED");
  return tx.done();
}

// --- Dropouts ---------------------------------------------------------------

function checkDropout(tx: Tx, commitmentId: string, participantId: string): Commitment | TransitionResult {
  const c = getCommitment(tx, commitmentId);
  if (isResult(c)) return c;
  if (c.participantId !== participantId) return fail("NOT_YOUR_COMMITMENT", "You can only drop yourself out.");
  if (tx.plan.status !== "OPEN" || tx.t >= tx.plan.captureCutoff.getTime()) {
    return fail("DROPOUT_CLOSED", "The cutoff has passed; spots are being charged.");
  }
  return c;
}

function askDropout(tx: Tx, c: Commitment): TransitionResult {
  const late = isLateDropout(tx.plan, tx.now);
  if (late) {
    const charge = lateDropoutChargeMinor(tx.plan.noReplacementRule, c.amountMinor);
    tx.emit({
      type: "ASK_CONFIRMATION",
      participantId: c.participantId,
      commitmentId: c.id,
      question: { kind: "DROPOUT_LATE", chargeIfUnfilledMinor: charge, currency: tx.plan.currency, captureCutoff: tx.plan.captureCutoff },
    });
  } else {
    tx.emit({ type: "ASK_CONFIRMATION", participantId: c.participantId, commitmentId: c.id, question: { kind: "DROPOUT_EARLY" } });
  }
  tx.put({ ...c, pendingConfirmation: { kind: late ? "DROPOUT_LATE" : "DROPOUT_EARLY", askedAt: tx.now } });
  return tx.done();
}

function dropoutRequested(tx: Tx, e: E<"DROPOUT_REQUESTED">): TransitionResult {
  const c = checkDropout(tx, e.commitmentId, e.participantId);
  if (isResult(c)) return c;
  if (c.status !== "COMMITTED") return fail("NOT_COMMITTED", `Cannot drop out from ${c.status}.`);
  return askDropout(tx, c);
}

function dropoutConfirmed(tx: Tx, e: E<"DROPOUT_CONFIRMED">): TransitionResult {
  const c = checkDropout(tx, e.commitmentId, e.participantId);
  if (isResult(c)) return c;
  if (c.status === "DROPPED_EARLY" || c.status === "DROPPED_LATE_SEEKING") return noop(tx.original, "already dropped");
  if (c.status !== "COMMITTED") return fail("NOT_COMMITTED", `Cannot drop out from ${c.status}.`);
  const asked = c.pendingConfirmation;
  if (!asked) return fail("NO_PENDING_CONFIRMATION", "Dropping out needs an explicit confirmation first.");

  const late = isLateDropout(tx.plan, tx.now);
  const stale = tx.t - asked.askedAt.getTime() > CONFIRMATION_TTL_MS;
  // If the consequence changed since we asked (deadline passed), ask again.
  if (stale || asked.kind !== (late ? "DROPOUT_LATE" : "DROPOUT_EARLY")) return askDropout(tx, c);

  const dropped: Commitment = { ...without(c, "pendingConfirmation"), droppedAt: tx.now };
  if (late) {
    // No money action yet: the authorization stays until replaced or captured at the cutoff.
    const seeking: Commitment = { ...dropped, status: "DROPPED_LATE_SEEKING" };
    tx.put(seeking);
    tx.tell(seeking, "DROPPED_LATE_SEEKING");
    tx.tellOrganizer(seeking, "DROPPED_LATE_SEEKING");
    tx.emit({ type: "FIND_REPLACEMENT", spotCommitmentId: c.id });
    return tx.done();
  }

  const early: Commitment = { ...dropped, status: "DROPPED_EARLY" };
  if (c.paypalAuthorizationId) {
    tx.put(tx.void(early, c.paypalAuthorizationId, "EARLY_DROPOUT_VOID", "DROPPED_EARLY"));
  } else {
    tx.put(early);
    tx.flag("MISSING_AUTHORIZATION", "Committed participant has no authorization id", c.id);
  }
  tx.tellOrganizer(early, "DROPPED_EARLY");
  tx.emit({ type: "FIND_REPLACEMENT", spotCommitmentId: c.id });
  return tx.done();
}

function dropoutDeclined(tx: Tx, e: E<"DROPOUT_DECLINED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  if (c.participantId !== e.participantId) return fail("NOT_YOUR_COMMITMENT", "You can only answer for yourself.");
  if (!c.pendingConfirmation) return noop(tx.original, "nothing to decline");
  tx.put(without(c, "pendingConfirmation"));
  return tx.done();
}

// --- Emergency release ------------------------------------------------------
// A late dropout asks; only the organizer decides; approval can only VOID, never charge.

function emergencyReleaseRequested(tx: Tx, e: E<"EMERGENCY_RELEASE_REQUESTED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  if (c.participantId !== e.participantId) return fail("NOT_YOUR_COMMITMENT", "You can only ask for yourself.");
  if (!tx.plan.emergencyReleaseEnabled) {
    return fail("EMERGENCY_RELEASE_NOT_ENABLED", "The organizer hasn't enabled emergency releases for this plan.");
  }
  if (tx.plan.status !== "OPEN" || tx.t >= tx.plan.captureCutoff.getTime()) {
    return fail("RELEASE_TOO_LATE", "The cutoff has passed, so the plan's dropout rule applies.");
  }
  const existing = c.emergencyRelease;
  if (existing?.status === "REQUESTED") return noop(tx.original, "already waiting for the organizer");
  if (existing) return fail("ALREADY_DECIDED", "The organizer has already answered this request.");
  if (c.status !== "DROPPED_LATE_SEEKING") return fail("NOT_DROPPED_LATE", "Emergency release is for confirmed late dropouts.");

  tx.put({ ...c, emergencyRelease: { status: "REQUESTED", requestedAt: tx.now } });
  tx.emit({
    type: "ASK_ORGANIZER",
    question:
      e.note === undefined
        ? { kind: "EMERGENCY_RELEASE", commitmentId: c.id, participantId: c.participantId }
        : { kind: "EMERGENCY_RELEASE", commitmentId: c.id, participantId: c.participantId, note: e.note },
  });
  tx.tell(c, "EMERGENCY_RELEASE_REQUESTED");
  return tx.done();
}

function emergencyReleaseDecided(tx: Tx, e: E<"EMERGENCY_RELEASE_DECIDED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  if (e.byParticipantId !== tx.plan.organizerId) return fail("NOT_ORGANIZER", "Only the organizer can decide an emergency release.");
  const request = c.emergencyRelease;
  if (!request) return fail("NO_PENDING_REQUEST", "Nobody asked for an emergency release.");
  if (request.status === "EXPIRED") return fail("RELEASE_TOO_LATE", "The cutoff passed before a decision; the plan's rule applied.");
  if (request.status !== "REQUESTED") {
    return (request.status === "APPROVED") === e.approved
      ? noop(tx.original, "decision already recorded")
      : fail("ALREADY_DECIDED", "This request has already been answered.");
  }
  if (tx.plan.status !== "OPEN" || tx.t >= tx.plan.captureCutoff.getTime()) {
    return fail("RELEASE_TOO_LATE", "The cutoff has passed, so the plan's dropout rule applies.");
  }
  // Replaced while the organizer was deciding: the hold is already released.
  if (c.status !== "DROPPED_LATE_SEEKING") return noop(tx.original, `already ${c.status}`);

  const decided = { ...request, status: e.approved ? "APPROVED" : "REFUSED", decidedAt: tx.now } as const;
  if (!e.approved) {
    tx.put({ ...c, emergencyRelease: decided });
    tx.tell(c, "EMERGENCY_RELEASE_REFUSED");
    return tx.done();
  }
  const released: Commitment = { ...c, status: "RELEASED_EMERGENCY", emergencyRelease: decided };
  if (c.paypalAuthorizationId) {
    tx.put(tx.void(released, c.paypalAuthorizationId, "EMERGENCY_RELEASE_VOID", "EMERGENCY_RELEASED"));
  } else {
    tx.put(released);
    tx.tell(released, "EMERGENCY_RELEASED");
    tx.flag("MISSING_AUTHORIZATION", "Released late dropout had no authorization id", c.id);
  }
  return tx.done();
}

// --- Offers -----------------------------------------------------------------

function offerSent(tx: Tx, e: E<"OFFER_SENT">): TransitionResult {
  const existing = tx.offers[e.offerId];
  if (existing) {
    return existing.spotCommitmentId === e.spotCommitmentId && existing.offeredToParticipantId === e.offeredToParticipantId
      ? noop(tx.original, "offer already recorded")
      : fail("DUPLICATE_ID", `Offer ${e.offerId} already exists.`);
  }
  const spot = getCommitment(tx, e.spotCommitmentId);
  if (isResult(spot)) return spot;
  if (!tx.spotNeedsFilling(spot)) return fail("SPOT_NOT_OPEN", "That spot does not need filling.");
  if (spot.participantId === e.offeredToParticipantId || tx.ofParticipant(e.offeredToParticipantId).some((c) => HAS_A_PLACE.has(c.status))) {
    return fail("ALREADY_JOINED", "That person already has a place in this plan.");
  }
  const closesAt = tx.offerClosesAt(spot);
  const expiresAt = e.expiresAt.getTime() < closesAt.getTime() ? e.expiresAt : closesAt;
  if (expiresAt.getTime() <= tx.t) return fail("OFFER_WINDOW_CLOSED", "Too late to offer this spot.");

  tx.putOffer({
    id: e.offerId,
    planId: tx.plan.id,
    spotCommitmentId: spot.id,
    offeredToParticipantId: e.offeredToParticipantId,
    sentAt: tx.now,
    expiresAt,
    status: "OPEN",
  });
  tx.emit({ type: "SCHEDULE_JOB", job: { kind: "OFFER_EXPIRY", offerId: e.offerId }, at: expiresAt });
  return tx.done();
}

function getOffer(tx: Tx, id: string): Offer | TransitionResult {
  return tx.offers[id] ?? fail("UNKNOWN_OFFER", `No offer ${id}`);
}

function offerAccepted(tx: Tx, e: E<"OFFER_ACCEPTED">): TransitionResult {
  const o = getOffer(tx, e.offerId);
  if (isResult(o)) return o;
  if (o.offeredToParticipantId !== e.participantId) return fail("NOT_OFFER_RECIPIENT", "This offer was sent to someone else.");
  if (o.status === "ACCEPTED") return noop(tx.original, "offer already accepted");
  if (o.status !== "OPEN") return fail("OFFER_NOT_OPEN", `The offer is ${o.status}.`);
  const spot = getCommitment(tx, o.spotCommitmentId);
  if (isResult(spot)) return spot;
  if (tx.t >= tx.plan.captureCutoff.getTime() && spot.status !== "CAPTURE_FAILED") {
    return fail("REPLACEMENT_AFTER_CUTOFF", "The cutoff has passed; this spot can no longer be replaced.");
  }
  if (tx.t >= o.expiresAt.getTime()) return fail("OFFER_EXPIRED", "The offer has expired.");
  if (!tx.spotNeedsFilling(spot)) return fail("SPOT_NOT_OPEN", "That spot has been filled.");

  const mine = tx.ofParticipant(e.participantId);
  if (mine.some((c) => HAS_A_PLACE.has(c.status) || (c.status === "PENDING_APPROVAL" && hasPending(c, "AUTHORIZE")))) {
    return fail("ALREADY_JOINED", "You already have a place in this plan.");
  }
  const reusable = mine.find((c) => c.status === "WAITLISTED" || c.status === "PENDING_APPROVAL");
  let c: Commitment;
  if (reusable) {
    c = tx.freshAttempt(reusable, spot.id);
  } else {
    if (tx.commitments[e.commitmentId]) return fail("DUPLICATE_ID", `Commitment ${e.commitmentId} already exists.`);
    c = { ...tx.newCommitment(e.commitmentId, e.participantId, "PENDING_APPROVAL"), replacesCommitmentId: spot.id };
  }
  tx.put(c);
  tx.putOffer({ ...o, status: "ACCEPTED" });
  tx.createOrder(c);
  return tx.done();
}

function offerDeclined(tx: Tx, e: E<"OFFER_DECLINED">): TransitionResult {
  const o = getOffer(tx, e.offerId);
  if (isResult(o)) return o;
  if (o.offeredToParticipantId !== e.participantId) return fail("NOT_OFFER_RECIPIENT", "This offer was sent to someone else.");
  if (o.status !== "OPEN") return noop(tx.original, `offer is ${o.status}`);
  tx.putOffer({ ...o, status: "DECLINED" });
  findNextIfNeeded(tx, o.spotCommitmentId);
  return tx.done();
}

function offerExpired(tx: Tx, e: E<"OFFER_EXPIRED">): TransitionResult {
  const o = getOffer(tx, e.offerId);
  if (isResult(o)) return o;
  if (o.status !== "OPEN") return noop(tx.original, `offer is ${o.status}`);
  if (tx.t < o.expiresAt.getTime()) return fail("OFFER_NOT_EXPIRED", "The offer has not expired yet.");
  tx.putOffer({ ...o, status: "EXPIRED" });
  findNextIfNeeded(tx, o.spotCommitmentId);
  return tx.done();
}

function findNextIfNeeded(tx: Tx, spotCommitmentId: string): void {
  const spot = tx.commitments[spotCommitmentId];
  if (spot && tx.spotNeedsFilling(spot)) tx.emit({ type: "FIND_REPLACEMENT", spotCommitmentId });
}

// --- Reauthorization ----------------------------------------------------------

function reauthDue(tx: Tx, e: E<"REAUTH_DUE">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  if (!HOLDS_AUTHORIZATION.has(c.status) || tx.plan.status !== "OPEN") return noop(tx.original, "no authorization to renew");
  // PayPal allows exactly one reauthorization.
  if (c.reauthorizedAt) return noop(tx.original, "already reauthorized once");
  if (c.reapproval && c.reapproval.status !== "DONE") return noop(tx.original, "reauthorization failed; re-approval flow instead");
  if (hasPending(c, "REAUTHORIZE")) return noop(tx.original, "reauthorization in flight");
  if (!c.paypalAuthorizationId || !c.authorizedAt) {
    tx.flag("MISSING_AUTHORIZATION", "Cannot reauthorize without an authorization", c.id);
    return tx.done();
  }
  if (tx.t < earliestReauthorization(c.authorizedAt).getTime()) {
    return fail("REAUTH_TOO_SOON", "PayPal only allows reauthorization from day 4 (engine waits 72 h + margin).");
  }
  if (tx.t - c.authorizedAt.getTime() >= AUTHORIZATION_VALIDITY_MS) return fail("AUTHORIZATION_EXPIRED", "The authorization is past its 29-day validity.");

  const id = moneyEventId(c.id, "REAUTHORIZE", c.paypalAuthorizationId);
  tx.emit({
    type: "REAUTHORIZE",
    moneyEventId: id,
    commitmentId: c.id,
    authorizationId: c.paypalAuthorizationId,
    amountMinor: c.amountMinor,
    currency: tx.plan.currency,
    rule: "HONOR_PERIOD_REAUTHORIZE",
  });
  tx.tell(c, "HOLD_RENEWING", { rule: "HONOR_PERIOD_REAUTHORIZE" });
  tx.put(addPending(c, { moneyEventId: id, action: "REAUTHORIZE", rule: "HONOR_PERIOD_REAUTHORIZE", authorizationId: c.paypalAuthorizationId }));
  return tx.done();
}

const RELEASE_RULE: Partial<Record<CommitmentStatus, RuleApplied>> = {
  RELEASED_CANCELLED: "PLAN_CANCELLED_VOID",
  DROPPED_EARLY: "EARLY_DROPOUT_VOID",
  REPLACED: "REPLACEMENT_VOID",
  RELEASED_EMERGENCY: "EMERGENCY_RELEASE_VOID",
};

function reauthSucceeded(tx: Tx, e: E<"REAUTH_SUCCEEDED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  const newId = e.newAuthorizationId;
  if (c.paypalAuthorizationId === newId || c.pendingMoneyActions.some((p) => p.authorizationId === newId)) {
    return noop(tx.original, "reauthorization already recorded");
  }
  const pending = findPending(c, "REAUTHORIZE");
  if (!pending) {
    tx.void(c, newId, "UNEXPECTED_AUTHORIZATION_VOID", "HOLD_RELEASED");
    tx.flag("UNEXPECTED_AUTHORIZATION", `Reauthorization ${newId} arrived without a pending reauthorize`, c.id);
    return tx.done();
  }
  const next = removePending(c, pending);
  if (HOLDS_AUTHORIZATION.has(c.status)) {
    // authorizedAt stays the original time: the 29-day window does not restart.
    tx.put({ ...next, paypalAuthorizationId: newId, reauthorizedAt: tx.now });
    tx.tell(c, "HOLD_RENEWED");
    return tx.done();
  }
  // They left (or the plan was cancelled) while PayPal was renewing: release the new hold too.
  tx.put(tx.void(next, newId, RELEASE_RULE[c.status] ?? "UNEXPECTED_AUTHORIZATION_VOID", "HOLD_RELEASED"));
  return tx.done();
}

function reauthFailed(tx: Tx, e: E<"REAUTH_FAILED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  const pending = findPending(c, "REAUTHORIZE");
  if (!pending) return noop(tx.original, "no reauthorization in flight");
  const next = removePending(c, pending);
  tx.flag("REAUTH_FAILED", e.reason, c.id);
  tx.tellOrganizer(c, "HOLD_RENEWAL_FAILED");
  if (!HOLDS_AUTHORIZATION.has(c.status) || !tx.beforeCutoff) {
    tx.put(next);
    return tx.done();
  }

  // Keep the old hold as a fallback (valid to day 29) and ask for a new approval.
  const deadline = reapprovalDeadline(tx.now, tx.plan.captureCutoff);
  if (deadline.getTime() <= tx.t) {
    // No time left to re-approve: offer the spot straight away.
    tx.put({ ...next, reapproval: { status: "EXPIRED", requestedAt: tx.now, deadline } });
    tx.tell(c, "REAPPROVAL_EXPIRED");
    tx.tellOrganizer(c, "REAPPROVAL_EXPIRED");
    findNextIfNeeded(tx, c.id);
    return tx.done();
  }
  const asked: Commitment = { ...next, reapproval: { status: "REQUESTED", requestedAt: tx.now, deadline } };
  tx.put(asked);
  tx.createOrder(asked, "REAPPROVAL");
  tx.emit({ type: "SCHEDULE_JOB", job: { kind: "REAPPROVAL_DEADLINE", commitmentId: c.id }, at: deadline });
  tx.tell(c, "REAPPROVAL_NEEDED", { deadline });
  return tx.done();
}

function reapprovalDeadlineReached(tx: Tx, e: E<"REAPPROVAL_DEADLINE">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  const ra = c.reapproval;
  if (ra?.status !== "REQUESTED") return noop(tx.original, "no re-approval open");
  if (tx.t < ra.deadline.getTime()) return fail("REAPPROVAL_NOT_DUE", "The re-approval window is still open.");
  if (hasPending(c, "AUTHORIZE")) return noop(tx.original, "re-approval authorization in flight");
  tx.put({ ...c, reapproval: { ...ra, status: "EXPIRED" } });
  if (HOLDS_AUTHORIZATION.has(c.status) && tx.beforeCutoff) {
    // Old hold stays: void it if someone takes the spot, else try it at the cutoff.
    tx.tell(c, "REAPPROVAL_EXPIRED");
    tx.tellOrganizer(c, "REAPPROVAL_EXPIRED");
    findNextIfNeeded(tx, c.id);
  }
  return tx.done();
}

// --- Void results -----------------------------------------------------------

function voidSucceeded(tx: Tx, e: E<"VOID_SUCCEEDED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  const pending = c.pendingMoneyActions.find((p) => p.action === "VOID" && p.authorizationId === e.authorizationId);
  if (pending) {
    tx.put(removePending(c, pending));
    return tx.done();
  }
  if (c.paypalAuthorizationId === e.authorizationId && HOLDS_AUTHORIZATION.has(c.status)) {
    // Voided outside CommitSpot (or expired): the spot is no longer backed by money.
    tx.flag("UNEXPECTED_VOID", `Live authorization ${e.authorizationId} was voided outside the engine`, c.id);
    return tx.done();
  }
  return noop(tx.original, "void already recorded");
}

function voidFailed(tx: Tx, e: E<"VOID_FAILED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  // The void stays pending; the reconcile job retries it with the same request id.
  tx.flag("VOID_FAILED", `${e.authorizationId}: ${e.reason}`, c.id);
  return tx.done();
}

// --- Cutoff and captures ------------------------------------------------------

function cutoffReached(tx: Tx): TransitionResult {
  if (tx.t < tx.plan.captureCutoff.getTime()) return fail("CUTOFF_NOT_REACHED", "The cutoff has not been reached.");
  if (tx.plan.status !== "OPEN" && tx.plan.status !== "LOCKED") return noop(tx.original, `plan is ${tx.plan.status}`);
  const wasLocked = tx.plan.status === "LOCKED";
  tx.plan = { ...tx.plan, status: "LOCKED" };

  for (const o of Object.values(tx.offers)) {
    const spot = tx.commitments[o.spotCommitmentId];
    if (o.status === "OPEN" && spot?.status !== "CAPTURE_FAILED") tx.putOffer({ ...o, status: "CANCELLED" });
  }

  // Undecided emergency releases and open re-approvals expire: the old hold and the plan's rule apply.
  for (const c of tx.list()) {
    let next = c;
    if (next.emergencyRelease?.status === "REQUESTED") {
      next = { ...next, emergencyRelease: { ...next.emergencyRelease, status: "EXPIRED", decidedAt: tx.now } };
    }
    if (next.reapproval?.status === "REQUESTED" && !hasPending(next, "AUTHORIZE")) {
      next = { ...next, reapproval: { ...next.reapproval, status: "EXPIRED" } };
    }
    if (next !== c) tx.put(next);
  }

  for (const c of tx.list()) {
    if (!HOLDS_AUTHORIZATION.has(c.status) || hasPending(c, "CAPTURE")) continue;
    if (hasPending(c, "REAUTHORIZE")) {
      // Capture must use the newest id; the job runs again once the reauthorization settles.
      tx.flag("MONEY_ACTION_IN_FLIGHT_AT_CUTOFF", "Reauthorization still in flight; capture deferred", c.id);
      continue;
    }
    if (!c.paypalAuthorizationId) {
      tx.flag("MISSING_AUTHORIZATION", `${c.status} commitment has no authorization to capture`, c.id);
      continue;
    }
    if (c.status === "COMMITTED") {
      tx.put(tx.capture(c, c.paypalAuthorizationId, c.amountMinor, "CUTOFF_CAPTURE_COMMITTED"));
      continue;
    }
    // DROPPED_LATE_SEEKING: nobody took the spot, apply the rule accepted at join.
    const rule = tx.plan.noReplacementRule;
    const applied: RuleApplied =
      rule.kind === "SPLIT_PERCENT" ? "CUTOFF_CAPTURE_LATE_DROPOUT_SPLIT_PERCENT" : "CUTOFF_CAPTURE_LATE_DROPOUT_FULL_SHARE";
    tx.put(tx.capture(c, c.paypalAuthorizationId, lateDropoutChargeMinor(rule, c.amountMinor), applied));
  }

  if (wasLocked && tx.effects.length === 0) return noop(tx.original, "cutoff already processed");
  return tx.done();
}

const PAID_RULES: ReadonlySet<RuleApplied> = new Set(["CUTOFF_CAPTURE_COMMITTED", "LATE_REPLACEMENT_CAPTURE"]);

function captureSucceeded(tx: Tx, e: E<"CAPTURE_SUCCEEDED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  if (c.captureId === e.captureId) return noop(tx.original, "capture already recorded");
  const pending = findPending(c, "CAPTURE");
  if (!pending) {
    tx.flag("UNEXPECTED_CAPTURE", `Capture ${e.captureId} without a pending capture (status ${c.status})`, c.id);
    return tx.done();
  }
  tx.put({
    ...removePending(c, pending),
    status: PAID_RULES.has(pending.rule) ? "PAID" : "CHARGED_MISSED_SPOT",
    captureId: e.captureId,
    capturedAmountMinor: e.amountMinor,
  });
  if (e.amountMinor !== pending.amountMinor) {
    tx.flag("CAPTURE_AMOUNT_MISMATCH", `Requested ${pending.amountMinor ?? "?"}, PayPal captured ${e.amountMinor}`, c.id);
  }
  tx.tell(c, "CHARGED", { amountMinor: e.amountMinor, currency: tx.plan.currency, rule: pending.rule });
  return tx.done();
}

function captureFailed(tx: Tx, e: E<"CAPTURE_FAILED">): TransitionResult {
  const c = getCommitment(tx, e.commitmentId);
  if (isResult(c)) return c;
  const pending = findPending(c, "CAPTURE");
  if (!pending) {
    if (c.status === "PAID" || c.status === "CHARGED_MISSED_SPOT") {
      // A completed capture is final: never move backwards.
      tx.flag("CAPTURE_FAILURE_AFTER_SUCCESS", e.reason, c.id);
      return tx.done();
    }
    return noop(tx.original, "no capture in flight");
  }
  const failed: Commitment = { ...removePending(c, pending), status: "CAPTURE_FAILED" };
  tx.put(failed);
  tx.tell(failed, "CHARGE_FAILED");
  tx.tellOrganizer(failed, "CHARGE_FAILED");
  findNextIfNeeded(tx, failed.id);
  return tx.done();
}
