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
const input = { id: "call-a", modelId: "model-a", now };
function reserved() {
  const result = reserveQuota({ observation, holds: [] }, input);
  if (result.kind !== "admitted") throw new Error("fixture");
  return result.state;
}
describe("observed subscription admission", () => {
  it("needs no request estimate and never fabricates a percentage reservation", () => {
    const state = reserved();
    expect(state.holds).toHaveLength(1);
    expect(state.holds[0]).not.toHaveProperty("percent");
    expect(reserveQuota(state, { ...input, id: "other-bot-call" })).toMatchObject({
      kind: "declined",
      reason: "busy",
    });
  });
  it("is idempotent for one physical call", () => {
    const state = reserved();
    expect(reserveQuota(state, input)).toMatchObject({ kind: "admitted", state });
  });
  it("skips an exhausted applicable window", () => {
    const exhausted = {
      ...observation,
      windows: [{ ...observation.windows[0]!, usedPercent: 100 }],
    };
    expect(reserveQuota({ observation: exhausted, holds: [] }, input)).toMatchObject({
      kind: "declined",
      reason: "exhausted",
    });
  });
  it("does not invent a buffer or claim to predict a request's cost", () => {
    const nearlyExhausted = {
      ...observation,
      windows: [{ ...observation.windows[0]!, usedPercent: 99.9 }],
    };
    expect(reserveQuota({ observation: nearlyExhausted, holds: [] }, input)).toMatchObject({
      kind: "admitted",
    });
  });
  it("does not apply an unrelated model's exhausted window", () => {
    const scoped = {
      ...observation,
      windows: [
        ...observation.windows,
        { id: "other-model", usedPercent: 100, resetsAt: reset, modelIds: ["other"] },
      ],
    };
    expect(reserveQuota({ observation: scoped, holds: [] }, input)).toMatchObject({
      kind: "admitted",
    });
  });
  it.each(["stale", "unavailable", "unsupported"] as const)(
    "declines a %s observation",
    (status) => {
      expect(
        reserveQuota({ observation: { ...observation, status }, holds: [] }, input),
      ).toMatchObject({ kind: "declined" });
    },
  );
  it("requires a fresh observation after reset and freshness expiry", () => {
    expect(reserveQuota({ observation, holds: [] }, { ...input, now: now + 61_000 })).toMatchObject(
      { kind: "declined", reason: "reset_pending" },
    );
    expect(
      reserveQuota({ observation, holds: [] }, { ...input, now: now + 121_000 }),
    ).toMatchObject({ kind: "declined", reason: "stale" });
  });
  it("keeps a completed call blocked until a new provider observation", () => {
    const state = settleQuota(JSON.parse(JSON.stringify(reserved())), input.id, false, now + 1000);
    expect(settleQuota(state, input.id, false, now + 2000)).toEqual(state);
    expect(observeQuota(state, observation).holds).toHaveLength(1);
    const fresh = { ...observation, observedAt: new Date(now + 2000).toISOString() };
    expect(observeQuota(state, { ...fresh, status: "stale" }).holds).toHaveLength(1);
    const updated = observeQuota(state, fresh);
    expect(updated.holds).toEqual([]);
    expect(reserveQuota(updated, { ...input, id: "next", now: now + 2000 })).toMatchObject({
      kind: "admitted",
    });
  });
  it("does not release an in-flight request even after another quota read", () => {
    expect(
      observeQuota(reserved(), { ...observation, observedAt: new Date(now + 2000).toISOString() })
        .holds,
    ).toHaveLength(1);
  });
  it("releases a definite rejection without waiting for another observation", () => {
    expect(settleQuota(reserved(), input.id, true).holds).toEqual([]);
  });
  it("accepts an old estimate record but retires it after completion and a fresh meter", () => {
    const state = reserved();
    state.holds[0]!.percent = 3;
    validateQuotaPool(state);
    const done = settleQuota(state, input.id, false, now + 1000);
    expect(
      observeQuota(done, { ...observation, observedAt: new Date(now + 2000).toISOString() }).holds,
    ).toEqual([]);
  });
  it("rejects corrupt persisted state", () => {
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
