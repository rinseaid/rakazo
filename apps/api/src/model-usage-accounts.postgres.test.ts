import { asSystem, createDb, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setConnectionUsageAccounts } from "./model-usage-accounts.js";
import type { RouterContext } from "./routes/context.js";

const suite = process.env.VERIFY_DATABASE ? describe : describe.skip;
suite("durable owned usage-account links", () => {
  const { prisma, pool } = createDb(process.env.DATABASE_URL!, { poolMax: 8 });
  const owner = { userId: "usage-owner-fixture", spaceId: "usage-space-fixture" };
  const foreign = { userId: "usage-foreign-fixture", spaceId: "usage-other-space-fixture" };
  const system = asSystem(prisma);
  const ctx = {
    deps: { prisma, secrets: { load: async (ciphertext: string) => ciphertext } },
  } as unknown as RouterContext;
  beforeAll(async () => {
    for (const userId of [owner.userId, foreign.userId])
      await system.user.create({
        data: { id: userId, name: "Usage fixture", email: `${userId}@example.test` },
      });
    for (const [id, userId] of [
      ["usage-a", owner.userId],
      ["usage-b", owner.userId],
      ["usage-foreign", foreign.userId],
    ])
      await system.secret.create({
        data: {
          id: `${id}-secret`,
          userId,
          spaceId: null,
          kind: "model",
          ciphertext: JSON.stringify({
            kind: "openai_compatible",
            baseUrl: "https://opencode.ai/zen/go/v1",
            apiKey: "fake-fixture-key",
          }),
        },
      });
  });
  beforeEach(async () => {
    await system.userModelCredential.deleteMany({
      where: { userId: { in: [owner.userId, foreign.userId] } },
    });
    for (const [id, userId] of [
      ["usage-a", owner.userId],
      ["usage-b", owner.userId],
      ["usage-foreign", foreign.userId],
    ])
      await system.userModelCredential.create({
        data: { id, userId, provider: "openai-compatible", label: id, secretId: `${id}-secret` },
      });
  });
  afterAll(async () => {
    await system.user.deleteMany({ where: { id: { in: [owner.userId, foreign.userId] } } });
    await prisma.$disconnect();
    await pool.end();
  });
  it("persists owned links and enforces row-level isolation", async () => {
    await runAsTenant(owner, () =>
      setConnectionUsageAccounts(ctx, owner.userId, "usage-a", ["usage-b"]),
    );
    expect(await runAsTenant(owner, () => prisma.userModelUsageAccount.count())).toBe(1);
    expect(await runAsTenant(foreign, () => prisma.userModelUsageAccount.findMany())).toEqual([]);
  });
  it("database constraints reject foreign-owner links and self-links", async () => {
    await expect(
      system.userModelUsageAccount.create({
        data: { credentialId: "usage-a", usageAccountId: "usage-foreign", userId: owner.userId },
      }),
    ).rejects.toThrow();
    await expect(
      system.userModelUsageAccount.create({
        data: { credentialId: "usage-a", usageAccountId: "usage-a", userId: owner.userId },
      }),
    ).rejects.toThrow();
    expect(await system.userModelUsageAccount.count()).toBe(0);
  });
  it("serializes simultaneous reciprocal links so only one can commit", async () => {
    const results = await runAsTenant(owner, () =>
      Promise.allSettled([
        setConnectionUsageAccounts(ctx, owner.userId, "usage-a", ["usage-b"]),
        setConnectionUsageAccounts(ctx, owner.userId, "usage-b", ["usage-a"]),
      ]),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(await system.userModelUsageAccount.count()).toBe(1);
  });
  it("deleting an upstream removes its links while preserving the gateway", async () => {
    await runAsTenant(owner, () =>
      setConnectionUsageAccounts(ctx, owner.userId, "usage-a", ["usage-b"]),
    );
    await system.userModelCredential.delete({ where: { id: "usage-b" } });
    expect(await system.userModelUsageAccount.count()).toBe(0);
    expect(
      await system.userModelCredential.findUnique({ where: { id: "usage-a" } }),
    ).not.toBeNull();
  });
});
