import { ORPCError } from "@orpc/server";
import type { ModelQuotaPolicy } from "@rakazo/contracts";
import { ModelQuotaPolicySchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";

export async function connectionQuotaPolicy(
  prisma: PrismaClient,
  userId: string,
  credentialId: string,
) {
  const row = await prisma.userModelCredential.findFirst({ where: { id: credentialId, userId } });
  if (!row) throw new ORPCError("NOT_FOUND");
  return ModelQuotaPolicySchema.parse(row.quotaPolicy ?? {});
}

export async function updateConnectionQuotaPolicy(
  prisma: PrismaClient,
  userId: string,
  credentialId: string,
  policy: ModelQuotaPolicy,
  quotaReady: () => Promise<boolean>,
) {
  await connectionQuotaPolicy(prisma, userId, credentialId);
  const parsed = ModelQuotaPolicySchema.parse(policy);
  if (parsed.enabled && !(await quotaReady()))
    throw new ORPCError("BAD_REQUEST", { message: "Quota unavailable" });
  const result = await prisma.userModelCredential.updateMany({
    where: { id: credentialId, userId },
    data: { quotaPolicy: parsed },
  });
  if (result.count !== 1) throw new ORPCError("NOT_FOUND");
  return parsed;
}
