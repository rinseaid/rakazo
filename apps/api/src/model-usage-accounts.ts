import { ORPCError } from "@orpc/server";
import { modelCredentialDto } from "@rakazo/adapters";
import { supportsUsageAccount } from "@rakazo/contracts";
import { Prisma } from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";
import { withSerializableRetry } from "./serializable-retry.js";

/** Links select read-only meters. Dispatch and quota admission always retain their own credentials. */
export async function setConnectionUsageAccounts(
  ctx: RouterContext,
  userId: string,
  credentialId: string,
  usageAccountIds: string[],
) {
  const ids = [...new Set(usageAccountIds)];
  return withSerializableRetry(() =>
    ctx.deps.prisma.$transaction(
      async (tx) => {
        const gateway = await tx.userModelCredential.findFirst({
          where: { id: credentialId, userId },
          include: { usageGateways: { select: { credentialId: true } } },
        });
        if (!gateway) throw new ORPCError("NOT_FOUND");
        if (
          gateway.provider !== "openai-compatible" ||
          ids.includes(credentialId) ||
          (ids.length && gateway.usageGateways.length)
        )
          throw new ORPCError("BAD_REQUEST", {
            message: "Usage accounts must be direct connections",
          });
        const accounts = await tx.userModelCredential.findMany({
          where: { id: { in: ids }, userId },
          include: { usageAccounts: { select: { usageAccountId: true } } },
        });
        if (accounts.length !== ids.length)
          throw new ORPCError("BAD_REQUEST", { message: "Usage account not available" });
        for (const account of accounts) {
          const secret = await tx.secret.findFirst({
            where: { id: account.secretId, userId, spaceId: null },
          });
          let plaintext: string | undefined;
          try {
            if (secret) plaintext = await ctx.deps.secrets.load(secret.ciphertext, secret.id);
          } catch {
            /* Unreadable credentials cannot supply usage. */
          }
          let supported = false;
          try {
            supported = supportsUsageAccount(modelCredentialDto(account, plaintext));
          } catch {
            /* Invalid stored credentials are unavailable. */
          }
          if (account.usageAccounts.length || !supported)
            throw new ORPCError("BAD_REQUEST", { message: "Usage account not available" });
        }
        await tx.userModelUsageAccount.deleteMany({ where: { credentialId, userId } });
        if (ids.length)
          await tx.userModelUsageAccount.createMany({
            data: ids.map((usageAccountId) => ({ credentialId, usageAccountId, userId })),
          });
        return { usageAccountIds: ids };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}
