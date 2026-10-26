import { randomUUID } from "node:crypto";
import type { PrismaClient, QuotaWaitInput } from "@rakazo/db";
import {
  asSystem,
  createDb,
  deferRunForQuota,
  loadRunTurnCheckpoint,
  provisionMessagingIdentity,
  runAsSystem,
  saveRunTurnCheckpoint,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const suite = process.env.VERIFY_DATABASE === "1" ? describe.sequential : describe.skip;
suite("durable quota wait (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  let identity: { userId: string; spaceId: string; botId: string; threadId: string };
  const address = `quota-wait-${randomUUID()}@example.test`;
  beforeAll(async () => {
    db = createDb(process.env.DATABASE_URL!);
    system = asSystem(db.prisma);
    identity = await runAsSystem("quota wait fixture", () =>
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
  async function fixture(): Promise<QuotaWaitInput> {
    const { userId, spaceId, botId, threadId } = identity;
    const scope = { userId, spaceId, botId, threadId };
    const task = await system.task.create({
      data: { ...scope, prompt: "fixture", status: "running" },
    });
    const run = await system.run.create({
      data: {
        ...scope,
        taskId: task.id,
        status: "running",
        trigger: "user",
        leaseOwner: "fixture-worker",
        leaseFence: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      },
    });
    const attempt = await system.attempt.create({
      data: { runId: run.id, fence: 1, status: "running" },
    });
    await runAsSystem("quota checkpoint fixture", () =>
      saveRunTurnCheckpoint(db.prisma, run, "fixture-worker", 1, "fixture saved transcript"),
    );
    return {
      ...scope,
      runId: run.id,
      taskId: task.id,
      attemptId: attempt.id,
      leaseOwner: "fixture-worker",
      leaseFence: 1,
      retryAt: new Date(Date.now() + 60_000).toISOString(),
    };
  }
  it("persists the wake time and checkpoint after releasing the worker lease", async () => {
    const input = await fixture();
    const deferred = await deferRunForQuota(system, input);
    expect(deferred).not.toBeNull();
    const run = await system.run.findUniqueOrThrow({ where: { id: input.runId } });
    expect(run).toMatchObject({
      status: "queued",
      leaseOwner: null,
      leaseExpiresAt: null,
      wakeAt: deferred!.wakeAt,
    });
    expect(
      await runAsSystem("quota checkpoint read", () => loadRunTurnCheckpoint(db.prisma, run)),
    ).toBe("fixture saved transcript");
    expect(await system.attempt.findUnique({ where: { id: input.attemptId } })).toMatchObject({
      status: "interrupted",
      finishedAt: expect.any(Date),
    });
    expect(await system.task.findUnique({ where: { id: input.taskId } })).toMatchObject({
      status: "queued",
    });
    const events = await system.event.findMany({
      where: { runId: input.runId },
      orderBy: { seq: "asc" },
    });
    expect(events.map((event) => event.type)).toEqual(["run.checkpointed", "thread.progress"]);
    expect(events.at(-1)!.seq).toBe(deferred!.seq);
  });
  it("rejects stale workers and never resurrects cancellation", async () => {
    const input = await fixture();
    expect(await deferRunForQuota(system, { ...input, leaseFence: 0 })).toBeNull();
    await system.run.update({ where: { id: input.runId }, data: { status: "cancelled" } });
    expect(await deferRunForQuota(system, input)).toBeNull();
    expect(await system.run.findUnique({ where: { id: input.runId } })).toMatchObject({
      status: "cancelled",
      wakeAt: null,
    });
  });
  it("rolls back the requeue if its active attempt cannot be fenced", async () => {
    const input = await fixture();
    await expect(
      deferRunForQuota(system, { ...input, attemptId: "missing-fixture" }),
    ).rejects.toThrow("Active run attempt");
    expect(await system.run.findUnique({ where: { id: input.runId } })).toMatchObject({
      status: "running",
      leaseOwner: "fixture-worker",
      wakeAt: null,
    });
  });
});
