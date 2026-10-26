import type { ModelQuota } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  observeQuota,
  reserveQuota,
  settleQuota,
  validateQuotaPool,
} from "./subscription-quota.js";

const now = Date.parse("2030-01-01T00:00:00Z");
const reset = new Date(now + 60_000).toISOString();
const observation: ModelQuota = {
  credentialId: "connection-a",
  status: "fresh",
  identityVerified: true,
  observedAt: new Date(now).toISOString(),
  checkedAt: new Date(now).toISOString(),
  windows: [{ id: "weekly", usedPercent: 80, resetsAt: reset, modelIds: null }],
};
const input = {
  id: "call-a",
  modelId: "model-a",
  reservePercent: 10,
  requestPercent: 2,
  uncertaintyPercent: 1,
  now,
};
function reserved() {
  const result = reserveQuota({ observation, holds: [] }, input);
  if (result.kind !== "admitted") throw new Error("fixture");
  return result.state;
}
describe("subscription reservations", () => {
  it("subtracts outstanding estimates and uncertainty from shared headroom", () => {
    let state = { observation, holds: [] } as ReturnType<typeof reserved>;
    const admitted: string[] = [];
    for (let i = 0; i < 10; i++) {
      const result = reserveQuota(state, { ...input, id: `call-${i}` });
      if (result.kind === "admitted") {
        state = result.state;
        admitted.push(result.reservationId);
      }
    }
    expect(admitted).toHaveLength(3);
    expect(state.holds.map((hold) => hold.percent)).toEqual([3, 3, 3]);
  });
  it("is idempotent for one physical call", () => {
    const state = reserved();
    expect(reserveQuota(state, input)).toMatchObject({ kind: "admitted", state });
    expect(state.holds).toHaveLength(1);
  });
  it("never invents a request estimate", () => {
    expect(
      reserveQuota({ observation, holds: [] }, { ...input, requestPercent: null }),
    ).toMatchObject({ kind: "declined", reason: "estimate_unknown" });
  });
  it.each([NaN, -1, 101])("rejects invalid policy values %s", (requestPercent) => {
    expect(() => reserveQuota({ observation, holds: [] }, { ...input, requestPercent })).toThrow();
  });
  it.each(["stale", "unavailable", "unsupported"] as const)(
    "does not admit a %s observation",
    (status) => {
      expect(
        reserveQuota({ observation: { ...observation, status }, holds: [] }, input),
      ).toMatchObject({ kind: "declined" });
    },
  );
  it("requires a new observation after a reset and after freshness expires", () => {
    expect(reserveQuota({ observation, holds: [] }, { ...input, now: now + 61_000 })).toMatchObject(
      { kind: "declined", reason: "reset_pending" },
    );
    expect(
      reserveQuota({ observation, holds: [] }, { ...input, now: now + 121_000 }),
    ).toMatchObject({ kind: "declined", reason: "stale" });
  });
  it("keeps unknown spend through a restart and settlement", () => {
    const state = settleQuota(JSON.parse(JSON.stringify(reserved())), input.id, false, now + 1000);
    expect(state.holds[0]).toMatchObject({ percent: 3, state: "uncertain" });
    expect(settleQuota(state, input.id, false, now + 2000)).toEqual(state);
  });
  it("releases only a proven rejection without spend", () => {
    expect(settleQuota(reserved(), input.id, true).holds).toEqual([]);
  });
  it("releases a completed old-window hold only on a fresh observed reset", () => {
    const state = settleQuota(reserved(), input.id, false, now + 1000);
    const next = {
      ...observation,
      observedAt: new Date(now + 61_000).toISOString(),
      windows: [
        {
          ...observation.windows[0]!,
          resetsAt: new Date(now + 121_000).toISOString(),
          usedPercent: 0,
        },
      ],
    };
    expect(observeQuota(state, { ...next, status: "stale" }).holds).toHaveLength(1);
    expect(observeQuota(state, next).holds).toEqual([]);
  });
  it("retains pending requests that cross a window reset", () => {
    const next = {
      ...observation,
      observedAt: new Date(now + 61_000).toISOString(),
      windows: [
        {
          ...observation.windows[0]!,
          resetsAt: new Date(now + 121_000).toISOString(),
          usedPercent: 0,
        },
      ],
    };
    const state = observeQuota(reserved(), next);
    expect(state.holds[0]?.windows.weekly).toBe(next.windows[0]?.resetsAt);
  });
  it("rejects corrupt persisted reservations instead of admitting against NaN", () => {
    const state = reserved();
    state.holds[0]!.percent = NaN;
    expect(() => validateQuotaPool(state)).toThrow();
  });
  it("does not regress to an older observation", () => {
    const state = reserved();
    expect(
      observeQuota(state, { ...observation, observedAt: new Date(now - 1000).toISOString() }),
    ).toBe(state);
  });
});
