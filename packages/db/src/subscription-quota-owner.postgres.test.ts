import { randomUUID } from "node:crypto";
import type { ModelQuota } from "@rakazo/contracts";
import type { QuotaPoolState } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  provisionMessagingIdentity,
  reserveSubscriptionQuota,
  runAsSystem,
  settleSubscriptionQuota,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const suite = process.env.VERIFY_DATABASE === "1" ? describe.sequential : describe.skip;
suite("subscription admission worker ownership (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `quota-owner-${randomUUID()}@example.test`;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!, { poolMax: 12 });
    system = asSystem(db.prisma);
    identity = await runAsSystem("quota owner fixture", () =>
      provisionMessagingIdentity(
        db.prisma,
        { provider: "email", address },
        { signupsEnabled: undefined, signupAllowlist: undefined },
      ),
    );
  });
  afterAll(async () => {
    if (identity) {
      await system.messagingIdentity.deleteMany({ where: { address } });
      await system.organization.deleteMany({ where: { id: identity.spaceId } });
      await system.user.deleteMany({ where: { id: identity.userId } });
    }
    if (db) {
      await db.prisma.$disconnect();
      await db.pool.end();
    }
  });
  function meter(at = Date.now()): ModelQuota {
    return {
      credentialId: "fixture-connection",
      status: "fresh",
      identityVerified: true,
      observedAt: new Date(at).toISOString(),
      checkedAt: new Date(at).toISOString(),
      windows: [
        {
          id: "weekly",
          usedPercent: 80,
          resetsAt: new Date(at + 86400_000).toISOString(),
          modelIds: null,
        },
      ],
    };
  }
  async function worker() {
    const { userId, spaceId, botId, threadId } = identity;
    const task = await system.task.create({
      data: { userId, spaceId, botId, threadId, prompt: "fixture", status: "running" },
    });
    const run = await system.run.create({
      data: {
        userId,
        spaceId,
        botId,
        threadId,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: `worker-${randomUUID()}`,
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 300_000),
      },
    });
    return { runId: run.id, leaseOwner: run.leaseOwner!, leaseFence: run.leaseFence };
  }
  const admit = (
    poolKey: string,
    owner: Awaited<ReturnType<typeof worker>>,
    observation = meter(),
    id: string = randomUUID(),
    now = Date.now(),
  ) =>
    reserveSubscriptionQuota(system, identity.userId, poolKey, observation, {
      id,
      modelId: "fixture-model",
      owner,
      now,
    });
  async function state(poolKey: string) {
    const row = await system.subscriptionQuotaPool.findUniqueOrThrow({
      where: { userId_poolKey: { userId: identity.userId, poolKey } },
    });
    return row.state as unknown as QuotaPoolState;
  }
  it("never expires a live owner's admission", async () => {
    const first = await worker(),
      second = await worker(),
      poolKey = randomUUID();
    expect(await admit(poolKey, first)).toMatchObject({ kind: "admitted" });
    expect(await admit(poolKey, second)).toMatchObject({ kind: "declined", reason: "busy" });
    expect((await state(poolKey)).holds[0]).toMatchObject({ state: "pending", owner: first });
  });
  it("fences a crashed worker and requires a later provider read before recovery", async () => {
    const crashed = await worker(),
      next = await worker(),
      poolKey = randomUUID();
    const first = await admit(poolKey, crashed);
    if (first.kind !== "admitted") throw new Error("fixture admission failed");
    await system.run.update({
      where: { id: crashed.runId },
      data: { leaseExpiresAt: new Date(0) },
    });
    const beforeRecovery = meter();
    expect(await admit(poolKey, next, beforeRecovery)).toMatchObject({
      kind: "declined",
      reason: "busy",
    });
    const revoked = await system.run.findUniqueOrThrow({ where: { id: crashed.runId } });
    expect(revoked).toMatchObject({ status: "running", leaseOwner: null, leaseFence: 2 });
    const orphan = (await state(poolKey)).holds[0]!;
    expect(orphan).toMatchObject({ state: "uncertain", completedAt: expect.any(Number) });
    expect(
      await system.run.updateMany({
        where: {
          id: crashed.runId,
          leaseOwner: crashed.leaseOwner,
          leaseFence: crashed.leaseFence,
        },
        data: { leaseExpiresAt: new Date(Date.now() + 300_000) },
      }),
    ).toMatchObject({ count: 0 });
    await expect(admit(poolKey, crashed)).rejects.toThrow("Run lease expired");
    // A genuinely later observation is required, even if the worker restart is immediate.
    const now = Math.max(Date.now(), orphan.completedAt! + 1);
    const resumed = await admit(poolKey, next, meter(now), "resumed-call", now);
    expect(resumed).toMatchObject({ kind: "admitted", reservationId: "resumed-call" });
    await settleSubscriptionQuota(system, identity.userId, poolKey, first.reservationId, true);
    expect((await state(poolKey)).holds).toMatchObject([
      { id: "resumed-call", state: "pending", owner: next },
    ]);
  });
  it.each(["cancelled", "completed", "failed"])(
    "recovers abandoned admission from a %s run without changing that run",
    async (status) => {
      const abandoned = await worker(),
        next = await worker(),
        poolKey = randomUUID();
      await admit(poolKey, abandoned);
      await system.run.update({ where: { id: abandoned.runId }, data: { status } });
      expect(await admit(poolKey, next)).toMatchObject({ kind: "declined", reason: "busy" });
      expect(await system.run.findUnique({ where: { id: abandoned.runId } })).toMatchObject({
        status,
        leaseFence: 1,
      });
      const now = Math.max(Date.now(), (await state(poolKey)).holds[0]!.completedAt! + 1);
      expect(await admit(poolKey, next, meter(now), randomUUID(), now)).toMatchObject({
        kind: "admitted",
      });
    },
  );
  it("allows exactly one new owner when recovery requests race", async () => {
    const abandoned = await worker(),
      contenders = await Promise.all(Array.from({ length: 5 }, worker));
    const poolKey = randomUUID();
    await admit(poolKey, abandoned);
    await system.run.update({
      where: { id: abandoned.runId },
      data: { leaseFence: 2, leaseOwner: "replacement-worker" },
    });
    await admit(poolKey, contenders[0]!);
    const now = Math.max(Date.now(), (await state(poolKey)).holds[0]!.completedAt! + 1);
    const results = await Promise.all(
      contenders.map((owner) => admit(poolKey, owner, meter(now), randomUUID(), now)),
    );
    expect(results.filter((result) => result.kind === "admitted")).toHaveLength(1);
    expect(results.filter((result) => result.kind === "declined")).toHaveLength(4);
  });
});
