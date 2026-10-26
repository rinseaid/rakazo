import type { ModelQuota } from "@rakazo/contracts";
import { asSystem, createDb, reserveSubscriptionQuota, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const suite = process.env.VERIFY_DATABASE ? describe : describe.skip;
suite("durable subscription quota", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL!, { poolMax: 12 });
  const actor = { userId: "quota-owner-fixture", spaceId: "quota-space-fixture" };
  const foreign = { userId: "quota-foreign-fixture", spaceId: "quota-other-space-fixture" };
  beforeAll(async () => {
    const system = asSystem(prisma);
    for (const userId of [actor.userId, foreign.userId])
      await system.user.create({
        data: { id: userId, name: "Quota fixture", email: `${userId}@example.test` },
      });
  });
  afterAll(async () => {
    await asSystem(prisma).user.deleteMany({
      where: { id: { in: [actor.userId, foreign.userId] } },
    });
    await prisma.$disconnect();
    await pool.end();
  });
  it("serializes concurrent bot reservations in PostgreSQL", async () => {
    const now = Date.now();
    const observation: ModelQuota = {
      credentialId: "connection-fixture",
      status: "fresh",
      identityVerified: true,
      observedAt: new Date(now).toISOString(),
      checkedAt: new Date(now).toISOString(),
      windows: [
        {
          id: "weekly",
          usedPercent: 80,
          resetsAt: new Date(now + 86400_000).toISOString(),
          modelIds: null,
        },
      ],
    };
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        runAsTenant(actor, () =>
          reserveSubscriptionQuota(prisma, actor.userId, "shared-pool-fixture", observation, {
            id: `call-${index}`,
            modelId: "model-fixture",
            reservePercent: 10,
            requestPercent: 2,
            uncertaintyPercent: 1,
            now,
          }),
        ),
      ),
    );
    expect(results.filter((result) => result.kind === "admitted")).toHaveLength(3);
    expect(results.filter((result) => result.kind === "declined")).toHaveLength(7);
  });
  it("enforces account row-level security", async () => {
    const rows = await runAsTenant(foreign, () =>
      prisma.subscriptionQuotaPool.findMany({ where: { userId: actor.userId } }),
    );
    expect(rows).toEqual([]);
  });
});
