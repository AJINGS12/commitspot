/** Test-only builders. Not exported from the package. */
import { transition } from "./stateMachine.js";
import type { Effect, Plan, PlanEvent, PlanState, TransitionResult } from "./types.js";

export const T = (iso: string): Date => new Date(iso);

/** Football Sat 7 Nov 2026, 18:00 UTC. Deadline Thu 18:00, cutoff Sat 12:00. 2 spots at $5. */
export function makePlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: "plan-1",
    platform: "telegram",
    chatId: "chat-1",
    organizerId: "org",
    title: "Football Sat 6pm",
    startsAt: T("2026-11-07T18:00:00Z"),
    timezone: "Europe/London",
    currency: "USD",
    pricePerSpotMinor: 500,
    spots: 2,
    freeDropoutDeadline: T("2026-11-05T18:00:00Z"),
    captureCutoff: T("2026-11-07T12:00:00Z"),
    noReplacementRule: { kind: "FULL_SHARE" },
    emergencyReleaseEnabled: true,
    status: "DRAFT",
    ...overrides,
  };
}

export function makeState(plan: Partial<Plan> = {}): PlanState {
  return { plan: makePlan(plan), commitments: {}, offers: {} };
}

/** Freeze deeply so any mutation of the input state throws in strict mode. */
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !(value instanceof Date) && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

/** Effects of every successful `step`, one array per transition, for invariant checks. */
export const allResults: Effect[][] = [];

/** Apply one event and require success. Freezes the input to prove purity. */
export function step(state: PlanState, event: PlanEvent, now: Date): { state: PlanState; effects: Effect[]; noop?: string } {
  const r = transition(deepFreeze(state), event, now);
  if (!r.ok) throw new Error(`${event.type} failed: ${r.error.code} ${r.error.message}`);
  allResults.push(r.effects);
  return r;
}

/** Apply one event and require a specific error. */
export function stepFails(state: PlanState, event: PlanEvent, now: Date): TransitionResult & { ok: false } {
  const r = transition(deepFreeze(state), event, now);
  if (r.ok) throw new Error(`${event.type} unexpectedly succeeded`);
  return r;
}

export const ofType = <K extends Effect["type"]>(effects: Effect[], type: K): Extract<Effect, { type: K }>[] =>
  effects.filter((e): e is Extract<Effect, { type: K }> => e.type === type);

export const moneyEffects = (effects: Effect[]) =>
  effects.filter((e) => e.type === "AUTHORIZE" || e.type === "VOID" || e.type === "REAUTHORIZE" || e.type === "CAPTURE");
