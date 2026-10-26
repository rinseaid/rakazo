import type { ModelQuota } from "@rakazo/contracts";
import type { QuotaHold, QuotaPoolState } from "@rakazo/core";
import { observeQuota, reserveQuota, settleQuota, validateQuotaPool } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import type { Prisma } from "./generated/prisma/client.js";

async function lockedPool<T>(
  prisma: PrismaClient,
  userId: string,
  poolKey: string,
  mutate: (
    state: QuotaPoolState,
    tx: Prisma.TransactionClient,
  ) => { state: QuotaPoolState; result: T } | Promise<{ state: QuotaPoolState; result: T }>,
) {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`INSERT INTO subscription_quota_pools ("userId", "poolKey", state, "updatedAt") VALUES (${userId}, ${poolKey}, '{"observation":null,"holds":[]}'::jsonb, NOW()) ON CONFLICT DO NOTHING`;
    const [row] = await tx.$queryRaw<
      Array<{ state: QuotaPoolState }>
    >`SELECT state FROM subscription_quota_pools WHERE "userId" = ${userId} AND "poolKey" = ${poolKey} FOR UPDATE`;
    if (!row) throw new Error("Quota ledger unavailable");
    validateQuotaPool(row.state);
    const next = await mutate(row.state, tx);
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
  return lockedPool(prisma, userId, poolKey, async (state, tx) => {
    const now = new Date(input.now);
    if (input.owner) {
      const owned = await tx.run.updateMany({
        where: {
          id: input.owner.runId,
          userId,
          status: { in: ["running", "leased"] },
          leaseOwner: input.owner.leaseOwner,
          leaseFence: input.owner.leaseFence,
          leaseExpiresAt: { gt: now },
        },
        data: { leaseFence: input.owner.leaseFence },
      });
      if (owned.count !== 1) throw new Error("Run lease expired before quota admission");
    }
    const holds: QuotaHold[] = [];
    for (const hold of state.holds) {
      if (hold.state !== "pending" || !hold.owner) {
        holds.push(hold);
        continue;
      }
      const owner = hold.owner;
      // Revoke an expired native fence before making its account reusable. A late
      // heartbeat or model call from that worker cannot reclaim the old fence.
      await tx.run.updateMany({
        where: {
          id: owner.runId,
          userId,
          status: { in: ["running", "leased"] },
          leaseOwner: owner.leaseOwner,
          leaseFence: owner.leaseFence,
          leaseExpiresAt: { lte: now },
        },
        data: { leaseOwner: null, leaseFence: { increment: 1 } },
      });
      const live = await tx.run.findFirst({
        where: {
          id: owner.runId,
          userId,
          status: { in: ["running", "leased"] },
          leaseOwner: owner.leaseOwner,
          leaseFence: owner.leaseFence,
          leaseExpiresAt: { gt: now },
        },
        select: { id: true },
      });
      holds.push(live ? hold : { ...hold, state: "uncertain", completedAt: input.now });
    }
    // The observation supplied with this request predates fencing above. Retain
    // recovered calls until a subsequent provider read confirms current usage.
    const observed = observeQuota({ ...state, holds }, observation);
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
