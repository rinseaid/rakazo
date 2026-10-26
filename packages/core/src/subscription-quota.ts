import type { ModelQuota } from "@rakazo/contracts";
import { ModelQuotaSchema } from "@rakazo/contracts";

export type QuotaHold = {
  id: string;
  percent: number;
  windows: Record<string, string | null>;
  state: "pending" | "uncertain";
  completedAt: number | null;
};
export type QuotaPoolState = { observation: ModelQuota | null; holds: QuotaHold[] };
export function validateQuotaPool(state: QuotaPoolState): void {
  if (!state || !Array.isArray(state.holds) || state.holds.length > 4096)
    throw new Error("Invalid quota ledger");
  if (state.observation !== null) ModelQuotaSchema.parse(state.observation);
  for (const hold of state.holds) {
    if (
      typeof hold.id !== "string" ||
      !hold.id ||
      !Number.isFinite(hold.percent) ||
      hold.percent <= 0 ||
      hold.percent > 200 ||
      !["pending", "uncertain"].includes(hold.state) ||
      (hold.completedAt !== null && !Number.isFinite(hold.completedAt)) ||
      !hold.windows ||
      typeof hold.windows !== "object" ||
      Array.isArray(hold.windows)
    )
      throw new Error("Invalid quota ledger");
    for (const reset of Object.values(hold.windows))
      if (reset !== null && (typeof reset !== "string" || !Number.isFinite(Date.parse(reset))))
        throw new Error("Invalid quota ledger");
  }
}
export type QuotaAdmissionReason =
  | "unavailable"
  | "stale"
  | "reset_pending"
  | "estimate_unknown"
  | "headroom";
export type QuotaAdmission =
  | { kind: "admitted"; state: QuotaPoolState; reservationId: string }
  | { kind: "declined"; reason: QuotaAdmissionReason; retryAt: string };

/** New provider observations never manufacture a reset or erase uncertain spend. */
export function observeQuota(state: QuotaPoolState, observation: ModelQuota): QuotaPoolState {
  if (observation.status !== "fresh" || !observation.identityVerified || !observation.observedAt)
    return state;
  if (state.observation?.observedAt && observation.observedAt < state.observation.observedAt)
    return state;
  const observedAt = Date.parse(observation.observedAt);
  const holds = state.holds
    .map((hold) => ({
      ...hold,
      windows: Object.fromEntries(
        Object.entries(hold.windows).flatMap(([id, oldReset]) => {
          const current = observation.windows.find((window) => window.id === id);
          if (!current?.resetsAt || oldReset === current.resetsAt) return [[id, oldReset]];
          if (
            oldReset &&
            hold.completedAt !== null &&
            hold.completedAt <= Date.parse(oldReset) &&
            observedAt >= Date.parse(oldReset)
          )
            return [];
          // A request spanning a reset can consume the new window.
          return [[id, current.resetsAt]];
        }),
      ),
    }))
    .filter((hold) => Object.keys(hold.windows).length > 0 || hold.state === "pending");
  return { observation, holds };
}

export function reserveQuota(
  state: QuotaPoolState,
  input: {
    id: string;
    modelId: string;
    reservePercent: number;
    requestPercent: number | null;
    uncertaintyPercent: number;
    now: number;
  },
): QuotaAdmission {
  const retryAt = new Date(input.now + 60_000).toISOString();
  const decline = (reason: QuotaAdmissionReason): QuotaAdmission => ({
    kind: "declined",
    reason,
    retryAt,
  });
  const observation = state.observation;
  if (!observation?.identityVerified || observation.status !== "fresh" || !observation.observedAt)
    return decline("unavailable");
  const age = input.now - Date.parse(observation.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 120_000) return decline("stale");
  if (input.requestPercent === null) return decline("estimate_unknown");
  for (const value of [input.requestPercent, input.uncertaintyPercent, input.reservePercent]) {
    if (!Number.isFinite(value) || value < 0 || value > 100)
      throw new Error("Invalid quota policy");
  }
  if (input.requestPercent <= 0 || input.uncertaintyPercent <= 0)
    throw new Error("Invalid quota estimate");
  const windows = observation.windows.filter(
    (window) => window.modelIds === null || window.modelIds.includes(input.modelId),
  );
  if (!windows.length) return decline("unavailable");
  if (windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= input.now))
    return decline("reset_pending");
  const existing = state.holds.find((hold) => hold.id === input.id);
  if (existing) return { kind: "admitted", state, reservationId: existing.id };
  const amount = input.requestPercent + input.uncertaintyPercent;
  if (
    state.holds.length >= 4096 ||
    windows.some((window) => {
      const reserved = state.holds.reduce(
        (sum, hold) => sum + (Object.hasOwn(hold.windows, window.id) ? hold.percent : 0),
        0,
      );
      return 100 - window.usedPercent - reserved - input.reservePercent < amount;
    })
  )
    return decline("headroom");
  return {
    kind: "admitted",
    reservationId: input.id,
    state: {
      ...state,
      holds: [
        ...state.holds,
        {
          id: input.id,
          percent: amount,
          windows: Object.fromEntries(windows.map((window) => [window.id, window.resetsAt])),
          state: "pending",
          completedAt: null,
        },
      ],
    },
  };
}

/** A percent meter cannot settle from token counts. Keep the estimate through resets. */
export function settleQuota(
  state: QuotaPoolState,
  id: string,
  rejectedWithoutSpend = false,
  now = Date.now(),
): QuotaPoolState {
  return {
    ...state,
    holds: rejectedWithoutSpend
      ? state.holds.filter((hold) => hold.id !== id)
      : state.holds.map((hold) =>
          hold.id === id && hold.state === "pending"
            ? { ...hold, state: "uncertain", completedAt: now }
            : hold,
        ),
  };
}
