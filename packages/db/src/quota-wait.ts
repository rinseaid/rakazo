import type { PrismaClient } from "./client.js";
import { expireComputerExecutionLeases } from "./computers.js";
import { appendEventInTransaction } from "./events.js";

export interface QuotaWaitInput {
  runId: string;
  spaceId: string;
  threadId: string;
  botId: string;
  taskId: string;
  attemptId: string;
  leaseOwner: string;
  leaseFence: number;
  retryAt: string;
}

/** Reuse the durable native queue; no worker, computer lease or timer stays occupied. */
export async function deferRunForQuota(prisma: PrismaClient, input: QuotaWaitInput) {
  const now = Date.now();
  const requested = Date.parse(input.retryAt);
  if (!Number.isFinite(requested)) throw new Error("Invalid quota retry time");
  const wakeAt = new Date(Math.max(now + 5_000, Math.min(requested, now + 60_000)));
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM threads WHERE id = ${input.threadId} FOR UPDATE`;
    const updated = await tx.run.updateMany({
      where: {
        id: input.runId,
        spaceId: input.spaceId,
        threadId: input.threadId,
        botId: input.botId,
        taskId: input.taskId,
        status: "running",
        leaseOwner: input.leaseOwner,
        leaseFence: input.leaseFence,
      },
      data: { status: "queued", wakeAt, leaseOwner: null, leaseExpiresAt: null },
    });
    if (updated.count !== 1) return null;
    await expireComputerExecutionLeases(tx, { runId: input.runId });
    const attempt = await tx.attempt.updateMany({
      where: {
        id: input.attemptId,
        runId: input.runId,
        fence: input.leaseFence,
        status: "running",
      },
      data: { status: "interrupted", finishedAt: new Date() },
    });
    if (attempt.count !== 1) throw new Error("Active run attempt was not available to defer");
    await tx.task.update({ where: { id: input.taskId }, data: { status: "queued" } });
    await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      runId: input.runId,
      type: "run.checkpointed",
      payload: { reason: "subscription_capacity", wakeAt: wakeAt.toISOString() },
    });
    const event = await appendEventInTransaction(tx, {
      spaceId: input.spaceId,
      threadId: input.threadId,
      botId: input.botId,
      runId: input.runId,
      type: "thread.progress",
      payload: {
        text: `Waiting for subscription capacity. Checking again at ${wakeAt.toISOString()}.`,
        activity: true,
      },
    });
    return { wakeAt, threadId: event.threadId, seq: event.seq };
  });
}
