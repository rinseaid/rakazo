import type { PrismaClient } from "./client.js";
import {
  ComputerLimitError,
  countInUseComputersForUser,
  lockUserForComputerQuota,
  resolveMaxComputersPerUser,
} from "./computers.js";
import { runAsSystem, runAsTenant } from "./row-security.js";
import { withTransactionRetry } from "./transaction-retry.js";

export interface AccountOperationHostLease {
  /** Immutable random UUID, also the remote host identity; never renewed or reused. */
  id: string;
  userId: string;
  spaceId: string;
  operationId: string;
  expiresAt: Date;
}

export const ACCOUNT_OPERATION_HOST_MAX_TTL_MS = 15 * 60_000;

function fence(lease: AccountOperationHostLease): AccountOperationHostLease {
  return {
    id: lease.id,
    userId: lease.userId,
    spaceId: lease.spaceId,
    operationId: lease.operationId,
    expiresAt: lease.expiresAt,
  };
}

/** Reserve quota before attempting remote creation, including uncertain creation outcomes. */
export async function reserveAccountOperationHost(
  prisma: PrismaClient,
  input: AccountOperationHostLease,
): Promise<AccountOperationHostLease> {
  const now = new Date();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.id) ||
    !input.userId.trim() ||
    !input.spaceId.trim() ||
    !input.operationId.trim() ||
    !Number.isFinite(input.expiresAt.getTime()) ||
    input.expiresAt.getTime() <= now.getTime() ||
    input.expiresAt.getTime() - now.getTime() > ACCOUNT_OPERATION_HOST_MAX_TTL_MS
  )
    throw new Error("Invalid account operation host lease");
  return runAsTenant(input, () =>
    withTransactionRetry(() =>
      prisma.$transaction(async (tx) => {
        await lockUserForComputerQuota(tx, input.userId);
        const limit = resolveMaxComputersPerUser();
        if (limit > 0 && (await countInUseComputersForUser(tx, input.userId)) >= limit)
          throw new ComputerLimitError(limit);
        if (input.expiresAt.getTime() <= Date.now())
          throw new Error("Account operation host lease expired before reservation");
        // Do not upsert: an immutable lease cannot be reacquired after unknown creation.
        const row = await tx.accountOperationHost.create({
          data: { ...fence(input), createdAt: now },
        });
        return fence(row);
      }),
    ),
  );
}

/** Mark cleanup due without freeing quota or claiming the remote host was destroyed. */
export async function requestAccountOperationHostCleanup(
  prisma: PrismaClient,
  lease: AccountOperationHostLease,
): Promise<boolean> {
  return runAsTenant(
    lease,
    async () =>
      (
        await prisma.accountOperationHost.updateMany({
          where: fence(lease),
          data: { cleanupRequestedAt: new Date() },
        })
      ).count === 1,
  );
}

/** Call ONLY after remote destruction (including absence) is positively confirmed. */
export async function releaseAccountOperationHostAfterDestruction(
  prisma: PrismaClient,
  lease: AccountOperationHostLease,
): Promise<boolean> {
  return runAsTenant(
    lease,
    async () =>
      (
        await prisma.accountOperationHost.deleteMany({
          where: fence(lease),
        })
      ).count === 1,
  );
}

/** Cleanup workers need retained owner fields even after a Space has been deleted. */
export async function listAccountOperationHostsForCleanup(
  prisma: PrismaClient,
  now = new Date(),
  limit = 100,
): Promise<AccountOperationHostLease[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
    throw new Error("Invalid account host cleanup batch size");
  return runAsSystem("destroy expired or abandoned isolated account hosts", () =>
    prisma.accountOperationHost.findMany({
      where: { OR: [{ expiresAt: { lte: now } }, { cleanupRequestedAt: { not: null } }] },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: limit,
      select: { id: true, userId: true, spaceId: true, operationId: true, expiresAt: true },
    }),
  );
}
