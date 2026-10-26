import type { ModelQuota } from "@rakazo/contracts";
import { ModelQuotaSchema } from "@rakazo/contracts";

export type QuotaHold = {
  id: string;
  owner?: { runId: string; leaseOwner: string; leaseFence: number };
  /** Retained only when reading a reservation written by an older test build. */
  percent?: number;
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
      (hold.percent !== undefined &&
        (!Number.isFinite(hold.percent) || hold.percent < 0 || hold.percent > 200)) ||
      !["pending", "uncertain"].includes(hold.state) ||
      (hold.completedAt !== null && !Number.isFinite(hold.completedAt)) ||
      !hold.windows ||
      typeof hold.windows !== "object" ||
      Array.isArray(hold.windows)
    )
      throw new Error("Invalid quota ledger");
    if (
      hold.owner &&
      (typeof hold.owner.runId !== "string" ||
        !hold.owner.runId ||
        typeof hold.owner.leaseOwner !== "string" ||
        !hold.owner.leaseOwner ||
        !Number.isInteger(hold.owner.leaseFence) ||
        hold.owner.leaseFence < 0)
    )
      throw new Error("Invalid quota owner");
    for (const reset of Object.values(hold.windows))
      if (reset !== null && (typeof reset !== "string" || !Number.isFinite(Date.parse(reset))))
        throw new Error("Invalid quota ledger");
  }
}
export type QuotaAdmissionReason = "unavailable" | "stale" | "reset_pending" | "busy" | "exhausted";
export type QuotaAdmission =
  | { kind: "admitted"; state: QuotaPoolState; reservationId: string }
  | { kind: "declined"; reason: QuotaAdmissionReason; retryAt: string };

/** Only a provider read started after completion can release the account for another call. */
export function observeQuota(state: QuotaPoolState, observation: ModelQuota): QuotaPoolState {
  if (observation.status !== "fresh" || !observation.identityVerified || !observation.observedAt)
    return state;
  if (state.observation?.observedAt && observation.observedAt < state.observation.observedAt)
    return state;
  const observedAt = Date.parse(observation.observedAt);
  const holds = state.holds.filter(
    (hold) =>
      hold.state === "pending" || hold.completedAt === null || observedAt <= hold.completedAt,
  );
  return { observation, holds };
}

export function reserveQuota(
  state: QuotaPoolState,
  input: {
    id: string;
    modelId: string;
    owner?: QuotaHold["owner"];
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
  const windows = observation.windows.filter(
    (window) => window.modelIds === null || window.modelIds.includes(input.modelId),
  );
  if (!windows.length) return decline("unavailable");
  if (windows.some((window) => window.resetsAt && Date.parse(window.resetsAt) <= input.now))
    return decline("reset_pending");
  const existing = state.holds.find((hold) => hold.id === input.id);
  if (existing) return { kind: "admitted", state, reservationId: existing.id };
  if (windows.some((window) => window.usedPercent >= 100)) return decline("exhausted");
  // Without a provider request-cost budget, reserve the account's next turn rather
  // than claiming several simultaneous calls fit a guessed percentage allowance.
  if (state.holds.length > 0) return decline("busy");
  return {
    kind: "admitted",
    reservationId: input.id,
    state: {
      ...state,
      holds: [
        ...state.holds,
        {
          id: input.id,
          ...(input.owner ? { owner: input.owner } : {}),
          windows: Object.fromEntries(windows.map((window) => [window.id, window.resetsAt])),
          state: "pending",
          completedAt: null,
        },
      ],
    },
  };
}

/** A completed call requires a new provider observation before the next admission. */
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
