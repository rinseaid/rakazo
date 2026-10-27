import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb } from "./client.js";
import { LocalKeyProvider } from "./content-keys.js";
import { finalizeRun } from "./events.js";
import { promoteNativeConversationCandidate } from "./native-conversation-candidate.js";
import type { NativeConversationBinding } from "./native-conversation-state.js";
import { claimNativeConversation, nativeContextCursor } from "./native-conversation-state.js";
import { runAsSystem } from "./row-security.js";

// Opt-in only against the repository's explicitly configured disposable test database.
const enabled = process.env.VERIFY_DATABASE === "1" && process.env.DATABASE_URL;
const postgres = enabled ? describe.sequential : describe.skip;

postgres("private native conversation persistence (PostgreSQL)", () => {
  const suffix = `native-state-${process.pid}-${Date.now()}`;
  const ids = {
    user: `${suffix}-user`,
    org: `${suffix}-org`,
    space: `${suffix}-space`,
    bot: `${suffix}-bot`,
    thread: `${suffix}-thread`,
    task: `${suffix}-task`,
    run: `${suffix}-run`,
    attempt: `${suffix}-attempt`,
    credential: `${suffix}-credential`,
    secret: `${suffix}-secret`,
    host: `${suffix}-host`,
    otherHost: `${suffix}-other-host`,
  };
  let db: ReturnType<typeof createDb>;
  const binding: NativeConversationBinding = {
    userId: ids.user,
    spaceId: ids.space,
    threadId: ids.thread,
    botId: ids.bot,
    helperNamespace: "main",
    provider: "fixture",
    credentialId: ids.credential,
    accountGeneration: ids.secret,
    modelId: "fixture-model",
    runtimeVersion: "1",
    hostBoundary: "private-fixture",
    historyGeneration: 0,
    contextBoundary: "fixture-system-tools",
  };
  const fence = { runId: ids.run, leaseOwner: "fixture-worker", leaseFence: 1, hostId: ids.host };
  const snapshot = {
    sessionId: "fixture-session",
    bytes: Buffer.from("sensitive-fixture-native-state"),
    cursor: nativeContextCursor(["fixture-user", "fixture-assistant"]),
  };
  async function commitCandidate(
    claim: Awaited<ReturnType<typeof claimNativeConversation>>,
    next = snapshot,
    runId = fence.runId,
  ) {
    const pending = claim.prepareCompleted({ sessionId: next.sessionId, bytes: next.bytes });
    const candidate = pending.bindCursor(next.cursor);
    return db.prisma.$transaction((tx) =>
      promoteNativeConversationCandidate(tx, candidate, {
        runId,
        leaseOwner: fence.leaseOwner,
        leaseFence: fence.leaseFence,
        userId: ids.user,
      }),
    );
  }
  beforeAll(() =>
    runAsSystem("native state test setup", async () => {
      db = createDb(process.env.DATABASE_URL!, {
        encryptContent: false,
        keyProvider: new LocalKeyProvider([
          { id: "native-state-test", key: new Uint8Array(32).fill(8) },
        ]),
      });
      const p = db.prisma;
      await p.user.create({
        data: { id: ids.user, name: "Fixture", email: `${ids.user}@rakazo.test` },
      });
      await p.organization.create({
        data: { id: ids.org, name: "Fixture", slug: ids.org, createdAt: new Date() },
      });
      await p.space.create({ data: { id: ids.space, organizationId: ids.org, name: "Fixture" } });
      await p.bot.create({
        data: { id: ids.bot, userId: ids.user, spaceId: ids.space, name: "Fixture", color: "ink" },
      });
      await p.thread.create({
        data: { id: ids.thread, spaceId: ids.space, userId: ids.user, botId: ids.bot },
      });
      await p.task.create({
        data: {
          id: ids.task,
          spaceId: ids.space,
          userId: ids.user,
          botId: ids.bot,
          threadId: ids.thread,
          prompt: "Fixture",
          status: "running",
        },
      });
      await p.run.create({
        data: {
          id: ids.run,
          spaceId: ids.space,
          userId: ids.user,
          botId: ids.bot,
          threadId: ids.thread,
          taskId: ids.task,
          trigger: "user",
          status: "running",
          leaseOwner: fence.leaseOwner,
          leaseFence: 1,
          leaseExpiresAt: new Date(Date.now() + 600000),
        },
      });
      await p.attempt.create({
        data: { id: ids.attempt, runId: ids.run, fence: fence.leaseFence, status: "running" },
      });
      await p.secret.create({
        data: {
          id: ids.secret,
          userId: ids.user,
          kind: "model",
          ciphertext: "fixture-account-reference",
        },
      });
      await p.userModelCredential.create({
        data: {
          id: ids.credential,
          userId: ids.user,
          provider: "fixture",
          label: "Fixture",
          secretId: ids.secret,
        },
      });
      for (const id of [ids.host, ids.otherHost])
        await p.accountOperationHost.create({
          data: {
            id,
            userId: ids.user,
            spaceId: ids.space,
            operationId: ids.run,
            expiresAt: new Date(Date.now() + 600000),
          },
        });
    }),
  );
  afterAll(() =>
    runAsSystem("native state test cleanup", async () => {
      if (!db) return;
      try {
        await db.prisma.accountOperationHost.deleteMany({
          where: { id: { in: [ids.host, ids.otherHost] } },
        });
        await db.prisma.organization.deleteMany({ where: { id: ids.org } });
        await db.prisma.user.deleteMany({ where: { id: ids.user } });
      } finally {
        await db.prisma.$disconnect();
        await db.pool.end();
      }
    }),
  );
  it("serializes competing claims and never puts plaintext in the row", () =>
    runAsSystem("native state concurrency test", async () => {
      const results = await Promise.allSettled([
        claimNativeConversation(db.prisma, binding, fence),
        claimNativeConversation(db.prisma, binding, { ...fence, hostId: ids.otherHost }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const winner = results.find((result) => result.status === "fulfilled");
      if (winner?.status !== "fulfilled") throw new Error("No claim won");
      await commitCandidate(winner.value);
      const rows = await db.prisma.nativeConversationState.findMany({
        where: { userId: ids.user },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.ciphertext).toMatch(/^rkz1:/);
      expect(rows[0]?.ciphertext).not.toContain("sensitive-fixture");
      const next = await claimNativeConversation(db.prisma, binding, fence);
      expect(next.snapshot).toEqual(snapshot);
      expect(
        (await db.prisma.nativeConversationState.findUnique({ where: { id: rows[0]!.id } }))
          ?.ciphertext,
      ).toBeNull();
      await commitCandidate(next);
    }));
  it("stores and reloads an exact 4MiB snapshot within the SQL ciphertext bound", () =>
    runAsSystem("native state size boundary test", async () => {
      const large = { ...snapshot, bytes: Buffer.alloc(4 * 1024 * 1024, 17) };
      const claim = await claimNativeConversation(db.prisma, binding, fence);
      await commitCandidate(claim, large);
      const row = await db.prisma.nativeConversationState.findFirstOrThrow({
        where: { userId: ids.user },
      });
      expect(Buffer.byteLength(row.ciphertext!)).toBeLessThan(8 * 1024 * 1024);
      const loaded = await claimNativeConversation(db.prisma, binding, fence);
      expect(loaded.snapshot?.sessionId).toBe(large.sessionId);
      expect(loaded.snapshot?.cursor).toEqual(large.cursor);
      expect(Buffer.from(loaded.snapshot!.bytes).equals(large.bytes)).toBe(true);
      await commitCandidate(loaded);
    }));
  it("promotes a private native candidate only with the successful history commit", () =>
    runAsSystem("native state history commit test", async () => {
      const claim = await claimNativeConversation(db.prisma, binding, fence);
      const assistantText = "The saved final answer.";
      const cursor = nativeContextCursor([
        "fixture-user",
        JSON.stringify({ role: "assistant", content: [{ type: "text", text: assistantText }] }),
      ]);
      const candidate = claim
        .prepareCompleted({ sessionId: snapshot.sessionId, bytes: snapshot.bytes })
        .bindCursor(cursor);
      expect(
        await db.prisma.nativeConversationState.findFirst({ where: { userId: ids.user } }),
      ).toMatchObject({ ciphertext: null, claimHostId: fence.hostId });
      const rejected = await finalizeRun(db.prisma, {
        spaceId: ids.space,
        threadId: ids.thread,
        botId: ids.bot,
        runId: ids.run,
        taskId: ids.task,
        attemptId: ids.attempt,
        leaseOwner: fence.leaseOwner,
        leaseFence: fence.leaseFence + 1,
        outcome: "completed",
        blocks: [{ kind: "text", text: assistantText }],
        nativeConversationCandidate: candidate,
      });
      expect(rejected).toBe(false);
      expect(
        await db.prisma.nativeConversationState.findFirst({ where: { userId: ids.user } }),
      ).toMatchObject({ ciphertext: null, claimHostId: fence.hostId });
      await expect(
        promoteNativeConversationCandidate(db.prisma, candidate, {
          ...fence,
          userId: ids.user,
        }),
      ).rejects.toThrow("Invalid native conversation commit candidate");
      await db.prisma.accountOperationHost.delete({ where: { id: ids.host } });
      const retryClaim = await claimNativeConversation(db.prisma, binding, {
        ...fence,
        hostId: ids.otherHost,
      });
      const retryCandidate = retryClaim
        .prepareCompleted({ sessionId: snapshot.sessionId, bytes: snapshot.bytes })
        .bindCursor(cursor);
      const committed = await finalizeRun(db.prisma, {
        spaceId: ids.space,
        threadId: ids.thread,
        botId: ids.bot,
        runId: ids.run,
        taskId: ids.task,
        attemptId: ids.attempt,
        leaseOwner: fence.leaseOwner,
        leaseFence: fence.leaseFence,
        outcome: "completed",
        blocks: [{ kind: "text", text: assistantText }],
        nativeConversationCandidate: retryCandidate,
      });
      expect(committed).toBeTruthy();
      const row = await db.prisma.nativeConversationState.findFirstOrThrow({
        where: { userId: ids.user },
      });
      expect(row.ciphertext).toMatch(/^rkz1:/);
      const nextRunId = `${ids.run}-next`;
      await db.prisma.run.create({
        data: {
          id: nextRunId,
          spaceId: ids.space,
          userId: ids.user,
          botId: ids.bot,
          threadId: ids.thread,
          taskId: ids.task,
          trigger: "user",
          status: "running",
          leaseOwner: fence.leaseOwner,
          leaseFence: fence.leaseFence + 1,
          leaseExpiresAt: new Date(Date.now() + 600000),
        },
      });
      await db.prisma.accountOperationHost.update({
        where: { id: ids.otherHost },
        data: { operationId: nextRunId },
      });
      const restored = await claimNativeConversation(db.prisma, binding, {
        ...fence,
        runId: nextRunId,
        leaseFence: fence.leaseFence + 1,
        hostId: ids.otherHost,
      });
      expect(restored.snapshot?.cursor).toEqual(cursor);
      expect(Buffer.from(restored.snapshot!.bytes).equals(snapshot.bytes)).toBe(true);
    }));
  it("cascades state when its account generation is deleted", () =>
    runAsSystem("native state generation deletion test", async () => {
      await db.prisma.secret.delete({ where: { id: ids.secret } });
      expect(await db.prisma.nativeConversationState.count({ where: { userId: ids.user } })).toBe(
        0,
      );
    }));
});
