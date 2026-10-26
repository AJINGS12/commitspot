/**
 * Domain types for CommitSpot (CLAUDE.md section 7).
 *
 * Money is always an integer number of minor units (cents, pence): fields end in `Minor`.
 * Times are `Date` values in UTC; each plan keeps its IANA time zone for display only.
 */

export type Platform = "telegram" | "discord";

/** ISO 4217 code supported by PayPal. See `PAYPAL_CURRENCIES` in money.ts. */
export type CurrencyCode = string;

export type PlanStatus = "DRAFT" | "OPEN" | "LOCKED" | "COMPLETED" | "CANCELLED";

export type CommitmentStatus =
  | "PENDING_APPROVAL"
  | "COMMITTED"
  | "WAITLISTED"
  | "DROPPED_EARLY"
  | "DROPPED_LATE_SEEKING"
  | "REPLACED"
  | "CHARGED_MISSED_SPOT"
  | "PAID"
  | "RELEASED_CANCELLED"
  /** Late dropout released by the organizer (emergency release); hold voided. */
  | "RELEASED_EMERGENCY"
  | "CAPTURE_FAILED";

export type OfferStatus = "OPEN" | "ACCEPTED" | "EXPIRED" | "DECLINED" | "CANCELLED";

/** What a late dropout pays if nobody takes their spot by the cutoff. Default FULL_SHARE. */
export type NoReplacementRule =
  | { kind: "FULL_SHARE" }
  /** Pays `percent` (1–100) of their own share, rounded down. The organizer absorbs the rest. */
  | { kind: "SPLIT_PERCENT"; percent: number };

export interface EmergencyReleaseRequest {
  status: "REQUESTED" | "APPROVED" | "REFUSED" | "EXPIRED";
  requestedAt: Date;
  decidedAt?: Date;
}

export interface Plan {
  id: string;
  platform: Platform;
  chatId: string;
  organizerId: string;
  title: string;
  startsAt: Date;
  timezone: string;
  currency: CurrencyCode;
  pricePerSpotMinor: number;
  spots: number;
  minHeadcount?: number;
  /** Dropouts strictly before this are early. At or after it they are late. */
  freeDropoutDeadline: Date;
  captureCutoff: Date;
  noReplacementRule: NoReplacementRule;
  /** Late dropouts may ask the organizer to release them (void, never charge). Default true. */
  emergencyReleaseEnabled: boolean;
  status: PlanStatus;
}

export interface Participant {
  id: string;
  platform: Platform;
  platformUserId: string;
  displayName: string;
  paypalPayerId?: string;
}

export type MoneyAction = "AUTHORIZE" | "VOID" | "REAUTHORIZE" | "CAPTURE";

/** The rule that justifies a money action. Logged in money_events (rule 4). */
export type RuleApplied =
  | "JOIN_APPROVED_AUTHORIZE"
  | "EARLY_DROPOUT_VOID"
  | "REPLACEMENT_VOID"
  | "SPOT_TAKEN_VOID"
  | "LATE_AUTHORIZATION_VOID"
  | "PLAN_CANCELLED_VOID"
  | "EMERGENCY_RELEASE_VOID"
  | "REAPPROVAL_AUTHORIZE"
  | "REAPPROVAL_SUPERSEDED_VOID"
  | "UNEXPECTED_AUTHORIZATION_VOID"
  | "HONOR_PERIOD_REAUTHORIZE"
  | "CUTOFF_CAPTURE_COMMITTED"
  | "CUTOFF_CAPTURE_LATE_DROPOUT_FULL_SHARE"
  | "CUTOFF_CAPTURE_LATE_DROPOUT_SPLIT_PERCENT"
  | "LATE_REPLACEMENT_CAPTURE";

/** A money action requested by the engine and not yet confirmed by PayPal. */
export interface PendingMoneyAction {
  moneyEventId: string;
  action: MoneyAction;
  rule: RuleApplied;
  orderId?: string;
  authorizationId?: string;
  amountMinor?: number;
}

export interface PendingConfirmation {
  kind: "DROPOUT_EARLY" | "DROPOUT_LATE";
  askedAt: Date;
}

export interface Commitment {
  id: string;
  planId: string;
  participantId: string;
  status: CommitmentStatus;
  amountMinor: number;
  createdAt: Date;
  paypalOrderId?: string;
  /** Always the newest authorization id; captures use this. */
  paypalAuthorizationId?: string;
  /** Time of the ORIGINAL authorization. PayPal's 29-day window counts from here. */
  authorizedAt?: Date;
  /** Set once the single allowed reauthorization succeeds. */
  reauthorizedAt?: Date;
  droppedAt?: Date;
  /** The commitment whose spot this one is trying to fill (offer acceptance). */
  replacesCommitmentId?: string;
  replacedByCommitmentId?: string;
  captureId?: string;
  capturedAmountMinor?: number;
  pendingMoneyActions: readonly PendingMoneyAction[];
  pendingConfirmation?: PendingConfirmation;
  emergencyRelease?: EmergencyReleaseRequest;
  /** Set when the reauthorization failed and the participant was asked to approve again. */
  reapproval?: Reapproval;
}

export interface Reapproval {
  /** DONE: a new authorization replaced the old hold. EXPIRED: window passed, spot offered. */
  status: "REQUESTED" | "DONE" | "EXPIRED";
  requestedAt: Date;
  /** min(failure + 24 h, cutoff − 2 h) */
  deadline: Date;
  /** The new PayPal order for the re-approval link. The old order and hold stay as a fallback. */
  orderId?: string;
}

export interface Offer {
  id: string;
  planId: string;
  spotCommitmentId: string;
  offeredToParticipantId: string;
  sentAt: Date;
  expiresAt: Date;
  status: OfferStatus;
}

export interface MoneyEvent {
  id: string;
  commitmentId: string;
  action: MoneyAction;
  ruleApplied: RuleApplied;
  requestId: string;
  paypalResponseId?: string;
  status: "PENDING" | "SUCCEEDED" | "FAILED";
  createdAt: Date;
}

/** The plan rules a participant agreed to when approving payment. Evidence for disputes. */
export interface RulesSnapshot {
  planId: string;
  title: string;
  currency: CurrencyCode;
  amountMinor: number;
  timezone: string;
  freeDropoutDeadline: string;
  captureCutoff: string;
  noReplacementRule: NoReplacementRule;
  emergencyReleaseEnabled: boolean;
}

export interface RulesAcceptance {
  commitmentId: string;
  rulesSnapshot: RulesSnapshot;
  acceptedAt: Date;
}

/** Everything the state machine needs about one plan. */
export interface PlanState {
  plan: Plan;
  commitments: Readonly<Record<string, Commitment>>;
  offers: Readonly<Record<string, Offer>>;
}

// ---------------------------------------------------------------------------
// Events in
// ---------------------------------------------------------------------------

export type PlanEvent =
  | { type: "OPEN_PLAN"; byParticipantId: string }
  | { type: "CANCEL_PLAN"; byParticipantId: string }
  | { type: "JOIN_REQUESTED"; commitmentId: string; participantId: string }
  | { type: "JOIN_WAITLIST"; commitmentId: string; participantId: string }
  | { type: "ORDER_CREATED"; commitmentId: string; orderId: string }
  | { type: "ORDER_APPROVED"; commitmentId: string; orderId: string }
  | { type: "AUTHORIZATION_SUCCEEDED"; commitmentId: string; authorizationId: string }
  | { type: "AUTHORIZATION_FAILED"; commitmentId: string; reason: string }
  | { type: "DROPOUT_REQUESTED"; commitmentId: string; participantId: string }
  | { type: "DROPOUT_CONFIRMED"; commitmentId: string; participantId: string }
  | { type: "DROPOUT_DECLINED"; commitmentId: string; participantId: string }
  /** `note` is the participant's own words, passed to the organizer as data. */
  | { type: "EMERGENCY_RELEASE_REQUESTED"; commitmentId: string; participantId: string; note?: string }
  | { type: "EMERGENCY_RELEASE_DECIDED"; commitmentId: string; byParticipantId: string; approved: boolean }
  | { type: "OFFER_SENT"; offerId: string; spotCommitmentId: string; offeredToParticipantId: string; expiresAt: Date }
  /** `commitmentId` is used for a new commitment; an existing waitlist entry is reused instead. */
  | { type: "OFFER_ACCEPTED"; offerId: string; participantId: string; commitmentId: string }
  | { type: "OFFER_DECLINED"; offerId: string; participantId: string }
  | { type: "OFFER_EXPIRED"; offerId: string }
  | { type: "REAUTH_DUE"; commitmentId: string }
  | { type: "REAUTH_SUCCEEDED"; commitmentId: string; newAuthorizationId: string }
  | { type: "REAUTH_FAILED"; commitmentId: string; reason: string }
  | { type: "REAPPROVAL_DEADLINE"; commitmentId: string }
  | { type: "VOID_SUCCEEDED"; commitmentId: string; authorizationId: string }
  | { type: "VOID_FAILED"; commitmentId: string; authorizationId: string; reason: string }
  | { type: "CUTOFF_REACHED" }
  | { type: "CAPTURE_SUCCEEDED"; commitmentId: string; captureId: string; amountMinor: number }
  | { type: "CAPTURE_FAILED"; commitmentId: string; reason: string }
  | { type: "COMPLETE_PLAN" };

// ---------------------------------------------------------------------------
// Effects out (performed by the executor in apps/server)
// ---------------------------------------------------------------------------

export type Audience =
  | { kind: "participant"; participantId: string }
  | { kind: "organizer" }
  | { kind: "group" };

export type NoticeKind =
  | "PLAN_OPENED"
  | "PLAN_CANCELLED"
  | "WAITLISTED"
  | "LOCKED_IN"
  | "AUTHORIZATION_FAILED"
  | "SPOT_TAKEN"
  | "JOIN_TOO_LATE"
  | "DROPPED_EARLY"
  | "DROPPED_LATE_SEEKING"
  | "REPLACED"
  | "REPLACEMENT_JOINED"
  | "HOLD_RELEASED"
  | "HOLD_RENEWING"
  | "HOLD_RENEWED"
  | "HOLD_RENEWAL_FAILED"
  | "CHARGING"
  | "CHARGED"
  | "CHARGE_FAILED"
  | "EMERGENCY_RELEASE_REQUESTED"
  | "EMERGENCY_RELEASED"
  | "EMERGENCY_RELEASE_REFUSED"
  | "REAPPROVAL_NEEDED"
  | "REAPPROVAL_EXPIRED"
  | "CUTOFF_IN_REAUTH_GAP";

/** Facts only. The agent's `explain` turns these into friendly chat text. */
export interface Notice {
  kind: NoticeKind;
  commitmentId?: string;
  amountMinor?: number;
  currency?: CurrencyCode;
  rule?: RuleApplied;
  deadline?: Date;
}

export type JobRef =
  | { kind: "CUTOFF"; planId: string }
  | { kind: "REAUTH"; commitmentId: string }
  | { kind: "REAPPROVAL_DEADLINE"; commitmentId: string }
  | { kind: "OFFER_EXPIRY"; offerId: string };

export type ConfirmationQuestion =
  | { kind: "DROPOUT_EARLY" }
  | { kind: "DROPOUT_LATE"; chargeIfUnfilledMinor: number; currency: CurrencyCode; captureCutoff: Date };

export type AnomalyCode =
  | "UNEXPECTED_AUTHORIZATION"
  | "UNEXPECTED_VOID"
  | "VOID_FAILED"
  | "UNEXPECTED_CAPTURE"
  | "CAPTURE_AMOUNT_MISMATCH"
  | "CAPTURE_FAILURE_AFTER_SUCCESS"
  | "MISSING_AUTHORIZATION"
  | "MONEY_ACTION_IN_FLIGHT_AT_CUTOFF"
  | "REAUTH_NOT_POSSIBLE"
  | "REAUTH_FAILED";

export type OrganizerQuestion = {
  kind: "EMERGENCY_RELEASE";
  commitmentId: string;
  participantId: string;
  note?: string;
};

export type Effect =
  | {
      type: "CREATE_ORDER";
      commitmentId: string;
      amountMinor: number;
      currency: CurrencyCode;
      description: string;
      /** JOIN: first approval. REAPPROVAL: new link after a failed reauthorization. */
      purpose: "JOIN" | "REAPPROVAL";
    }
  | { type: "AUTHORIZE"; moneyEventId: string; commitmentId: string; orderId: string; rule: RuleApplied }
  | { type: "VOID"; moneyEventId: string; commitmentId: string; authorizationId: string; rule: RuleApplied }
  | {
      type: "REAUTHORIZE";
      moneyEventId: string;
      commitmentId: string;
      authorizationId: string;
      amountMinor: number;
      currency: CurrencyCode;
      rule: RuleApplied;
    }
  | {
      type: "CAPTURE";
      moneyEventId: string;
      commitmentId: string;
      authorizationId: string;
      amountMinor: number;
      currency: CurrencyCode;
      finalCapture: true;
      rule: RuleApplied;
    }
  | { type: "RECORD_RULES_ACCEPTANCE"; acceptance: RulesAcceptance }
  | { type: "SCHEDULE_JOB"; job: JobRef; at: Date }
  /** Ask the agent to rank candidates and send an offer for this spot. */
  | { type: "FIND_REPLACEMENT"; spotCommitmentId: string }
  | { type: "ASK_CONFIRMATION"; participantId: string; commitmentId: string; question: ConfirmationQuestion }
  | { type: "ASK_ORGANIZER"; question: OrganizerQuestion }
  | { type: "NOTIFY"; to: Audience; notice: Notice }
  | { type: "FLAG_ANOMALY"; code: AnomalyCode; commitmentId?: string; detail: string };

export type MoneyEffect = Extract<Effect, { type: MoneyAction }>;

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export type TransitionErrorCode =
  | "UNKNOWN_COMMITMENT"
  | "UNKNOWN_OFFER"
  | "DUPLICATE_ID"
  | "NOT_ORGANIZER"
  | "INVALID_PLAN_STATUS"
  | "RULES_INVALID"
  | "PLAN_NOT_OPEN"
  | "PLAN_LOCKED"
  | "JOIN_NOT_YET_OPEN"
  | "JOIN_CLOSED"
  | "PLAN_FULL"
  | "ALREADY_JOINED"
  | "ORDER_MISMATCH"
  | "NOT_YOUR_COMMITMENT"
  | "NOT_COMMITTED"
  | "NO_PENDING_CONFIRMATION"
  | "DROPOUT_CLOSED"
  | "SPOT_NOT_OPEN"
  | "OFFER_WINDOW_CLOSED"
  | "NOT_OFFER_RECIPIENT"
  | "OFFER_NOT_OPEN"
  | "OFFER_EXPIRED"
  | "OFFER_NOT_EXPIRED"
  | "REPLACEMENT_AFTER_CUTOFF"
  | "REAUTH_TOO_SOON"
  | "AUTHORIZATION_EXPIRED"
  | "CUTOFF_NOT_REACHED"
  | "EMERGENCY_RELEASE_NOT_ENABLED"
  | "NOT_DROPPED_LATE"
  | "NO_PENDING_REQUEST"
  | "ALREADY_DECIDED"
  | "RELEASE_TOO_LATE"
  | "REAPPROVAL_NOT_DUE"
  | "NOT_READY_TO_COMPLETE";

export interface TransitionError {
  code: TransitionErrorCode;
  message: string;
}

export type TransitionResult =
  | { ok: true; state: PlanState; effects: Effect[]; noop?: string }
  | { ok: false; error: TransitionError };

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };
