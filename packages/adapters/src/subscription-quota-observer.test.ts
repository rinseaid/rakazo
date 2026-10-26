import type { ModelCallObserver, SecretStore } from "@rakazo/adapter-kit";
import { SubscriptionQuotaDeclinedError } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { reserveSubscriptionQuota, settleSubscriptionQuota } from "@rakazo/db";
import { beforeEach, expect, it, vi } from "vitest";
import type { ModelQuotaReader } from "./model-quota.js";
import { subscriptionQuotaObserver } from "./subscription-quota-observer.js";

vi.mock("@rakazo/db", () => ({
  reserveSubscriptionQuota: vi.fn(),
  settleSubscriptionQuota: vi.fn(),
}));
vi.mock("./model-selection.js", () => ({
  loadStoredModelSecret: vi.fn(async () => ({
    status: "loaded",
    ciphertext: "encrypted-fixture",
    plaintext: JSON.stringify({
      kind: "oauth",
      credential: {
        access: "fake-token",
        expires: Date.now() + 120_000,
        accountId: "fake-account",
      },
    }),
  })),
}));
vi.mock("./pi-oauth.js", () => ({
  parseModelSecret: JSON.parse,
  oauthCredentialAccountId: (value: { accountId?: string }) => value.accountId,
  kickModelCredentialRefresh: vi.fn(),
}));
vi.mock("./undici-fetch.js", () => ({ dispatcherFetch: vi.fn() }));

const scope = { userId: "user-a", spaceId: "space-a" };
const credential = {
  id: "connection-a",
  quotaPolicy: { enabled: true },
};
const call = {
  callId: "call-a",
  provider: "openai-codex",
  modelId: "model-a",
  inputTokensEstimate: 100,
  maxOutputTokens: 100,
};
function fixture() {
  const findFirst = vi.fn(async () => ({
    id: credential.id,
    provider: call.provider,
    secretId: "secret-a",
  }));
  const prisma = { userModelCredential: { findFirst } } as unknown as PrismaClient;
  const read = vi.fn(async () => ({ poolKey: "pool-a", view: { status: "fresh" } }));
  const reader = { read } as unknown as ModelQuotaReader;
  const observer = subscriptionQuotaObserver(
    { prisma, secretStore: {} as SecretStore },
    scope,
    credential,
    reader,
  )!;
  return { observer, read, findFirst, prisma, reader };
}
beforeEach(() => {
  vi.mocked(reserveSubscriptionQuota).mockReset();
  vi.mocked(settleSubscriptionQuota).mockReset();
});
it("keeps existing routing unchanged when quota policy is disabled", () => {
  const f = fixture();
  expect(
    subscriptionQuotaObserver(
      { prisma: f.prisma, secretStore: {} as SecretStore },
      scope,
      { id: credential.id },
      f.reader,
    ),
  ).toBeUndefined();
  expect(f.findFirst).not.toHaveBeenCalled();
});
it("reserves the verified shared pool for the exact owned credential", async () => {
  const f = fixture();
  vi.mocked(reserveSubscriptionQuota).mockResolvedValue({
    kind: "admitted",
    reservationId: call.callId,
    state: { observation: null, holds: [] },
  });
  expect(await f.observer.beforeCall(call)).toBe(call.callId);
  expect(f.findFirst).toHaveBeenCalledWith({ where: { id: credential.id, userId: scope.userId } });
  expect(reserveSubscriptionQuota).toHaveBeenCalledWith(
    f.prisma,
    scope.userId,
    "pool-a",
    expect.anything(),
    { id: call.callId, modelId: call.modelId, now: expect.any(Number) },
  );
  await f.observer.afterCall(call.callId, null);
  expect(settleSubscriptionQuota).toHaveBeenCalledWith(
    f.prisma,
    scope.userId,
    "pool-a",
    call.callId,
    false,
  );
});
it("declines stale or unknown quota without touching reservations", async () => {
  const f = fixture();
  f.read.mockResolvedValue({ poolKey: null, view: { status: "stale" } } as never);
  await expect(f.observer.beforeCall(call)).rejects.toBeInstanceOf(SubscriptionQuotaDeclinedError);
  expect(reserveSubscriptionQuota).not.toHaveBeenCalled();
});
it("returns a typed capacity decline when the pool has insufficient headroom", async () => {
  const f = fixture();
  vi.mocked(reserveSubscriptionQuota).mockResolvedValue({
    kind: "declined",
    reason: "exhausted",
    retryAt: new Date().toISOString(),
  });
  await expect(f.observer.beforeCall(call)).rejects.toMatchObject({ reason: "exhausted" });
});
it("does not relabel a local ledger failure as capacity", async () => {
  const f = fixture();
  const failure = new Error("503 ledger timeout");
  vi.mocked(reserveSubscriptionQuota).mockRejectedValue(failure);
  await expect(f.observer.beforeCall(call)).rejects.toBe(failure);
});
it.each(["not-started", "provider-rejected"])(
  "releases a proven %s reservation",
  async (usageSource) => {
    const f = fixture();
    vi.mocked(reserveSubscriptionQuota).mockResolvedValue({
      kind: "admitted",
      reservationId: call.callId,
      state: { observation: null, holds: [] },
    });
    await f.observer.beforeCall(call);
    await f.observer.afterCall(call.callId, { usageSource } as Parameters<
      ModelCallObserver["afterCall"]
    >[1]);
    expect(settleSubscriptionQuota).toHaveBeenCalledWith(
      f.prisma,
      scope.userId,
      "pool-a",
      call.callId,
      true,
    );
  },
);
