import type { ModelQuota } from "@rakazo/contracts";
import type { QuotaPoolState } from "@rakazo/core";
import { observeQuota, reserveQuota, settleQuota, validateQuotaPool } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";

async function lockedPool<T>(
  prisma: PrismaClient,
  userId: string,
  poolKey: string,
  mutate: (state: QuotaPoolState) => { state: QuotaPoolState; result: T },
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO subscription_quota_pools ("userId", "poolKey", state, "updatedAt") VALUES (${userId}, ${poolKey}, '{"observation":null,"holds":[]}'::jsonb, NOW()) ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<
      Array<{ state: QuotaPoolState }>
    >`SELECT state FROM subscription_quota_pools WHERE "userId" = ${userId} AND "poolKey" = ${poolKey} FOR UPDATE`;
    if (!row) throw new Error("Quota ledger unavailable");
    validateQuotaPool(row.state);
    const next = mutate(row.state);
    await tx.subscriptionQuotaPool.update({
      where: { userId_poolKey: { userId, poolKey } },
      data: { state: next.state as unknown as Prisma.InputJsonValue },
    });
    return next.result;
  });
}

export async function reserveSubscriptionQuota(
  prisma: PrismaClient,
  userId: string,
  poolKey: string,
  observation: ModelQuota,
  input: Parameters<typeof reserveQuota>[1],
) {
  if (observation.status !== "fresh")
    return {
      kind: "declined" as const,
      reason: "stale" as const,
      retryAt: new Date(input.now + 60_000).toISOString(),
    };
  return lockedPool(prisma, userId, poolKey, (state) => {
    const observed = observeQuota(state, observation);
    const result = reserveQuota(observed, input);
    return { state: result.kind === "admitted" ? result.state : observed, result };
  });
}

export async function settleSubscriptionQuota(
  prisma: PrismaClient,
  userId: string,
  poolKey: string,
  reservationId: string,
  rejectedWithoutSpend = false,
) {
  return lockedPool(prisma, userId, poolKey, (state) => ({
    state: settleQuota(state, reservationId, rejectedWithoutSpend),
    result: undefined,
  }));
}
