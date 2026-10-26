/** Validation and interpretation of a plan's rules. Pure: `now` is always passed in. */
import { formatMoney, isMinorUnits, isSupportedCurrency, percentOfMinor } from "./money.js";
import { MAX_JOIN_LEAD_MS, cutoffInReauthGap } from "./reauth.js";
import type { NoReplacementRule, Plan, Result, RulesSnapshot } from "./types.js";

/** Defaults for a new plan's rules (CLAUDE.md 7.5). */
export const PLAN_DEFAULTS: Readonly<Pick<Plan, "noReplacementRule" | "emergencyReleaseEnabled">> = Object.freeze({
  noReplacementRule: Object.freeze({ kind: "FULL_SHARE" }),
  emergencyReleaseEnabled: true,
});

export type RuleViolationCode =
  | "TITLE_EMPTY"
  | "PRICE_INVALID"
  | "SPOTS_INVALID"
  | "MIN_HEADCOUNT_INVALID"
  | "CURRENCY_NOT_SUPPORTED"
  | "TIMEZONE_INVALID"
  | "DEADLINE_AFTER_CUTOFF"
  | "CUTOFF_AFTER_START"
  | "CUTOFF_IN_PAST"
  | "SPLIT_PERCENT_INVALID"
  | "SPLIT_CHARGE_ROUNDS_TO_ZERO";

export interface RuleViolation {
  code: RuleViolationCode;
  message: string;
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

export function validatePlanRules(plan: Plan, now: Date): Result<void, RuleViolation[]> {
  const v: RuleViolation[] = [];
  const add = (code: RuleViolationCode, message: string) => v.push({ code, message });

  if (plan.title.trim() === "") add("TITLE_EMPTY", "The plan needs a title.");
  if (!isMinorUnits(plan.pricePerSpotMinor) || plan.pricePerSpotMinor === 0) {
    add("PRICE_INVALID", "Price per spot must be a positive whole number of minor units.");
  }
  if (!Number.isSafeInteger(plan.spots) || plan.spots < 1) add("SPOTS_INVALID", "Spots must be a whole number of at least 1.");
  if (
    plan.minHeadcount !== undefined &&
    (!Number.isSafeInteger(plan.minHeadcount) || plan.minHeadcount < 1 || plan.minHeadcount > plan.spots)
  ) {
    add("MIN_HEADCOUNT_INVALID", "Minimum headcount must be between 1 and the number of spots.");
  }
  if (!isSupportedCurrency(plan.currency)) add("CURRENCY_NOT_SUPPORTED", `PayPal does not support ${plan.currency}.`);
  if (!isValidTimeZone(plan.timezone)) add("TIMEZONE_INVALID", `Unknown time zone: ${plan.timezone}.`);

  if (plan.freeDropoutDeadline.getTime() > plan.captureCutoff.getTime()) {
    add("DEADLINE_AFTER_CUTOFF", "The free-dropout deadline must be at or before the capture cutoff.");
  }
  if (plan.captureCutoff.getTime() > plan.startsAt.getTime()) {
    add("CUTOFF_AFTER_START", "The capture cutoff must be at or before the start time.");
  }
  if (plan.captureCutoff.getTime() <= now.getTime()) add("CUTOFF_IN_PAST", "The capture cutoff is already in the past.");

  const rule = plan.noReplacementRule;
  if (rule.kind === "SPLIT_PERCENT") {
    if (!Number.isInteger(rule.percent) || rule.percent < 1 || rule.percent > 100) {
      add("SPLIT_PERCENT_INVALID", "The split must be a whole percentage from 1 to 100.");
    } else if (isMinorUnits(plan.pricePerSpotMinor) && percentOfMinor(plan.pricePerSpotMinor, rule.percent) === 0) {
      add("SPLIT_CHARGE_ROUNDS_TO_ZERO", "The split charge rounds down to nothing; raise the percentage or the price.");
    }
  }
  return v.length === 0 ? { ok: true, value: undefined } : { ok: false, error: v };
}

/** The deadline is exclusive: at or after it, a dropout is late. */
export function isLateDropout(plan: Plan, now: Date): boolean {
  return now.getTime() >= plan.freeDropoutDeadline.getTime();
}

/** What an unreplaced late dropout is charged at the cutoff. Never more than their share (rule 3). */
export function lateDropoutChargeMinor(rule: NoReplacementRule, shareMinor: number): number {
  switch (rule.kind) {
    case "FULL_SHARE":
      return shareMinor;
    case "SPLIT_PERCENT":
      return Math.min(shareMinor, percentOfMinor(shareMinor, rule.percent));
  }
}

/** Earliest time anyone can join, so every authorization stays valid until the cutoff. */
export function joinOpensAt(plan: Plan): Date {
  return new Date(plan.captureCutoff.getTime() - MAX_JOIN_LEAD_MS);
}

export function rulesSnapshot(plan: Plan): RulesSnapshot {
  return {
    planId: plan.id,
    title: plan.title,
    currency: plan.currency,
    amountMinor: plan.pricePerSpotMinor,
    timezone: plan.timezone,
    freeDropoutDeadline: plan.freeDropoutDeadline.toISOString(),
    captureCutoff: plan.captureCutoff.toISOString(),
    noReplacementRule: plan.noReplacementRule,
    emergencyReleaseEnabled: plan.emergencyReleaseEnabled,
  };
}

/**
 * Fixed wording of the money rules for the plan card ("organizer") and the approval page
 * ("participants"). Deterministic on purpose: money terms are never left to the LLM.
 */
export function rulesSummary(plan: Plan, audience: "participants" | "organizer", locale = "en-US"): string[] {
  const share = plan.pricePerSpotMinor;
  const money = (minor: number) => formatMoney(minor, plan.currency, locale);
  const rule = plan.noReplacementRule;
  const lines: string[] = [];

  if (rule.kind === "FULL_SHARE") {
    lines.push(
      audience === "participants"
        ? `If you drop out after the free-dropout deadline and nobody takes your spot, you pay your full share (${money(share)}).`
        : `Late dropouts whose spot isn't filled pay their full share (${money(share)}).`,
    );
  } else {
    const charge = lateDropoutChargeMinor(rule, share);
    lines.push(
      audience === "participants"
        ? `If you drop out after the free-dropout deadline and nobody takes your spot, you pay ${rule.percent}% of your share (${money(charge)}); the organizer covers the rest.`
        : `Late dropouts pay ${rule.percent}% (${money(charge)}) if nobody takes their spot; you cover the rest (${money(share - charge)}).`,
    );
  }

  if (plan.emergencyReleaseEnabled) {
    lines.push(
      audience === "participants"
        ? "In an emergency you can ask the organizer to release you; if they agree, you pay nothing."
        : "In an emergency, a late dropout can ask you to release them; if you agree, they pay nothing.",
    );
  }
  return lines;
}

export interface PlanWarning {
  code: "CUTOFF_IN_REAUTH_GAP";
  message: string;
}

/** Non-blocking warnings for the organizer when they confirm a plan. */
export function planWarnings(plan: Plan, now: Date): PlanWarning[] {
  const warnings: PlanWarning[] = [];
  if (cutoffInReauthGap(plan.captureCutoff, now)) {
    warnings.push({
      code: "CUTOFF_IN_REAUTH_GAP",
      message:
        "The cutoff is 72 to 73 hours away. Holds placed now can't be renewed before it, so PayPal won't guarantee those payments. Consider moving the cutoff.",
    });
  }
  return warnings;
}
