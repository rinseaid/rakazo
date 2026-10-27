import { describe, expect, it, vi } from "vitest";
import type { Prisma, PrismaClient } from "./client.js";
import type { DataKey } from "./content-crypto.js";
import { promoteNativeConversationCandidate } from "./native-conversation-candidate.js";
import type { NativeConversationBinding } from "./native-conversation-state.js";
import {
  claimNativeConversation,
  MAX_NATIVE_CONVERSATION_BYTES,
  nativeContextCursor,
  nativeContextDelta,
  nativeConversationBindingId,
} from "./native-conversation-state.js";

const binding: NativeConversationBinding = {
  userId: "user",
  spaceId: "space",
  threadId: "thread",
  botId: "bot",
  helperNamespace: "main",
  provider: "fixture",
  credentialId: "credential",
  accountGeneration: "generation-one",
  modelId: "model",
  runtimeVersion: "1",
  hostBoundary: "private-image-v1",
  historyGeneration: 0,
  contextBoundary: "instructions-tools-strategy-digest",
};
const fence = { runId: "run", leaseOwner: "worker", leaseFence: 1, hostId: "private-host" };
const snapshot = {
  sessionId: "session-one",
  bytes: Buffer.from("sensitive-native-header-fixture"),
  cursor: nativeContextCursor(["user: first", "assistant: answer"]),
};
const key: DataKey = { id: "key", spaceId: "space", version: 1, key: new Uint8Array(32).fill(9) };

function fixture() {
  type Row = {
    id: string;
    revision: number;
    claimHostId: string | null;
    ciphertext: string | null;
  };
  let row: Row | undefined;
  const runLock = vi.fn(async () => ({ count: 1 }));
  const hostLock = vi.fn(async () => ({ count: 1 }));
  const accountLock = vi.fn(async () => ({ count: 1 }));
  const contextLock = vi.fn(async () => ({ count: 1 }));
  const active = vi.fn(async () => ({ id: "private-host" }) as { id: string } | null);
  const put = vi.fn(async ({ where, data }) => {
    if (
      !row ||
      row.revision !== where.revision ||
      row.claimHostId !== where.claimHostId ||
      row.ciphertext !== null
    )
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const ring = {
    encryptWrites: false,
    current: vi.fn(async () => key),
    byId: vi.fn(async () => key),
  };
  const client = {
    $contentEncryption: () => ({ ring }),
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => {
      const previous = row ? { ...row } : undefined;
      try {
        return await action(client);
      } catch (error) {
        row = previous;
        throw error;
      }
    },
    run: { updateMany: runLock },
    accountOperationHost: { updateMany: hostLock, findFirst: active },
    userModelCredential: {
      updateMany: accountLock,
      findFirst: vi.fn(async () => ({ id: binding.credentialId })),
    },
    thread: {
      updateMany: contextLock,
      findFirst: vi.fn(async () => ({ id: binding.threadId })),
    },
    nativeConversationState: {
      upsert: vi.fn(async ({ create }) => {
        row = row
          ? { ...row, revision: row.revision + 1 }
          : { ...create, claimHostId: null, ciphertext: null };
        return { ...row };
      }),
      update: vi.fn(async ({ data }) => {
        Object.assign(row!, data);
        return row;
      }),
      updateMany: put,
    },
  };
  return {
    client: client as unknown as PrismaClient,
    raw: client,
    ring,
    row: () => row!,
    put,
    runLock,
    hostLock,
    accountLock,
    contextLock,
    active,
  };
}

async function commit(
  f: ReturnType<typeof fixture>,
  candidate: ReturnType<Awaited<ReturnType<typeof claimNativeConversation>>["prepareCompleted"]>,
  cursor = snapshot.cursor,
  runId = fence.runId,
) {
  const token = candidate.bindCursor(cursor);
  return promoteNativeConversationCandidate(f.raw as unknown as Prisma.TransactionClient, token, {
    ...fence,
    runId,
    userId: binding.userId,
  });
}

async function promote(
  f: ReturnType<typeof fixture>,
  claim: Awaited<ReturnType<typeof claimNativeConversation>>,
  next = snapshot,
  runId = fence.runId,
) {
  return commit(
    f,
    claim.prepareCompleted({ sessionId: next.sessionId, bytes: next.bytes }),
    next.cursor,
    runId,
  );
}

describe("private durable native conversations", () => {
  it("forces encryption with content encryption off; atomically consumes before reuse", async () => {
    const f = fixture();
    const claim = await claimNativeConversation(f.client, binding, fence);
    expect(claim.snapshot).toBeUndefined();
    const candidate = claim.prepareCompleted({
      sessionId: snapshot.sessionId,
      bytes: snapshot.bytes,
    });
    expect(f.row().ciphertext).toBeNull();
    await promoteNativeConversationCandidate(
      f.raw as unknown as Prisma.TransactionClient,
      candidate.bindCursor(snapshot.cursor),
      { ...fence, userId: binding.userId },
    );
    expect(f.row().ciphertext).toMatch(/^rkz1:/);
    expect(f.row().ciphertext).not.toContain("sensitive-native");
    expect(f.row().ciphertext).not.toContain(snapshot.bytes.toString("base64"));
    const next = await claimNativeConversation(f.client, binding, {
      ...fence,
      hostId: "next-host",
    });
    expect(next.snapshot).toEqual(snapshot);
    expect(f.row().ciphertext).toBeNull();
    expect(JSON.stringify(next)).toBe("{}");
  });
  it("survives separate runs but not a superseded revision or repeated completion", async () => {
    const f = fixture();
    const first = await claimNativeConversation(f.client, binding, fence);
    const firstCandidate = first.prepareCompleted({
      sessionId: snapshot.sessionId,
      bytes: snapshot.bytes,
    });
    await commit(f, firstCandidate);
    expect(() => firstCandidate.bindCursor(snapshot.cursor)).toThrow("already bound");
    const next = await claimNativeConversation(f.client, binding, { ...fence, runId: "next-run" });
    f.row().revision += 1;
    expect(await promote(f, next, snapshot, "next-run")).toBe(false);
    expect(f.row().ciphertext).toBeNull();
  });
  it("discards an in-memory candidate without making it reusable or durable", async () => {
    const f = fixture();
    const claim = await claimNativeConversation(f.client, binding, fence);
    const pending = claim.prepareCompleted({
      sessionId: snapshot.sessionId,
      bytes: snapshot.bytes,
    });
    pending.discard();
    expect(() => pending.bindCursor(snapshot.cursor)).toThrow("was discarded");
    expect(f.row().ciphertext).toBeNull();
    expect(f.put).not.toHaveBeenCalled();
  });
  it("keeps the opaque candidate available when a transaction attempt rolls back", async () => {
    const f = fixture();
    const claim = await claimNativeConversation(f.client, binding, fence);
    const token = claim
      .prepareCompleted({ sessionId: snapshot.sessionId, bytes: snapshot.bytes })
      .bindCursor(snapshot.cursor);
    const before = { ...f.row() };
    await expect(
      (async () => {
        await promoteNativeConversationCandidate(
          f.raw as unknown as Prisma.TransactionClient,
          token,
          { ...fence, userId: binding.userId },
        );
        throw Object.assign(new Error("synthetic serialization conflict"), { code: "P2034" });
      })(),
    ).rejects.toMatchObject({ code: "P2034" });
    Object.assign(f.row(), before);
    expect(
      await promoteNativeConversationCandidate(
        f.raw as unknown as Prisma.TransactionClient,
        token,
        { ...fence, userId: binding.userId },
      ),
    ).toBe(true);
  });
  it("refuses an unconfirmed host claim; destroyed host state remains invalidated", async () => {
    const f = fixture();
    await claimNativeConversation(f.client, binding, fence);
    await expect(
      claimNativeConversation(f.client, binding, { ...fence, hostId: "competitor" }),
    ).rejects.toThrow("already in use");
    f.active.mockResolvedValue(null);
    const claim = await claimNativeConversation(f.client, binding, {
      ...fence,
      hostId: "replacement",
    });
    expect(claim.snapshot).toBeUndefined();
  });
  it.each(["runLock", "hostLock", "accountLock", "contextLock"] as const)(
    "rejects stale %s before publishing",
    async (lock) => {
      const f = fixture();
      f[lock].mockResolvedValue({ count: 0 });
      await expect(claimNativeConversation(f.client, binding, fence)).rejects.toThrow();
      expect(f.put).not.toHaveBeenCalled();
      expect(f.row()).toBeUndefined();
    },
  );
  it("uses the actual loaded account generation and fences host/run ownership", async () => {
    const f = fixture();
    await claimNativeConversation(f.client, binding, fence);
    expect(f.accountLock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          secretId: binding.accountGeneration,
          userId: binding.userId,
        }),
      }),
    );
    expect(f.hostLock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: fence.hostId,
          operationId: fence.runId,
          cleanupRequestedAt: null,
        }),
      }),
    );
    expect(f.runLock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          leaseFence: fence.leaseFence,
          leaseOwner: fence.leaseOwner,
          status: "running",
        }),
      }),
    );
  });
  it("fails closed without encryption keys", async () => {
    const f = fixture();
    delete (f.raw as Partial<typeof f.raw>).$contentEncryption;
    await expect(claimNativeConversation(f.client, binding, fence)).rejects.toThrow("encryption");
    expect(f.row()).toBeUndefined();
  });
  it("rejects plaintext, tampered ciphertext and cross-binding substitution", async () => {
    for (const attack of ["plaintext", "tamper", "binding"] as const) {
      const f = fixture();
      const claim = await claimNativeConversation(f.client, binding, fence);
      await promote(f, claim);
      if (attack === "plaintext") f.row().ciphertext = "unsealed state";
      if (attack === "tamper") f.row().ciphertext = `${f.row().ciphertext!.slice(0, -8)}AAAAAAAA`;
      await expect(
        claimNativeConversation(
          f.client,
          attack === "binding" ? { ...binding, helperNamespace: "other-helper" } : binding,
          fence,
        ),
      ).rejects.toThrow();
      if (attack === "binding") expect(f.row().ciphertext).toMatch(/^rkz1:/);
      else expect(f.row().ciphertext).toBeNull();
    }
  });
  it.each([
    "modelId",
    "runtimeVersion",
    "hostBoundary",
    "contextBoundary",
    "historyGeneration",
    "accountGeneration",
  ] as const)("invalidates changed %s in the same bounded slot", async (field) => {
    const f = fixture();
    const previous = await claimNativeConversation(f.client, binding, fence);
    await promote(f, previous);
    const id = f.row().id;
    const next = await claimNativeConversation(
      f.client,
      { ...binding, [field]: field === "historyGeneration" ? 1 : "changed" },
      fence,
    );
    expect(next.snapshot).toBeUndefined();
    expect(f.row().id).toBe(id);
    expect(f.row().ciphertext).toBeNull();
  });
  it("rejects oversized or path-like session state without truncation", async () => {
    const f = fixture();
    const claim = await claimNativeConversation(f.client, binding, fence);
    expect(() =>
      claim.prepareCompleted({
        sessionId: snapshot.sessionId,
        bytes: new Uint8Array(MAX_NATIVE_CONVERSATION_BYTES + 1),
      }),
    ).toThrow();
    expect(() =>
      claim.prepareCompleted({ sessionId: "../other", bytes: snapshot.bytes }),
    ).toThrow();
    expect(f.put).not.toHaveBeenCalled();
  });
  it.each(Object.keys(binding) as Array<keyof NativeConversationBinding>)(
    "binds %s independently",
    (field) => {
      const changed = { ...binding, [field]: field === "historyGeneration" ? 1 : "other" };
      expect(nativeConversationBindingId(changed)).not.toBe(nativeConversationBindingId(binding));
    },
  );
});

describe("native delivered-context cursor", () => {
  it("returns only a matching prefix's new messages", () => {
    const cursor = nativeContextCursor(["user:a", "assistant:b"]);
    expect(nativeContextDelta(["user:a", "assistant:b", "user:c"], cursor)).toEqual(["user:c"]);
    expect(nativeContextDelta(["user:a", "assistant:edited", "user:c"], cursor)).toBeUndefined();
    expect(nativeContextDelta(["user:a"], cursor)).toBeUndefined();
    expect(nativeContextDelta(["user:a", "assistant:b"], cursor)).toEqual([]);
  });
  it("does not accept count-only cursors", () => {
    expect(() => nativeContextDelta(["user:a"], { count: 1, prefixHash: "" })).toThrow();
  });
});
