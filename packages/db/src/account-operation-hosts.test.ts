import { afterEach, describe, expect, it, vi } from "vitest";
import {
  listAccountOperationHostsForCleanup,
  releaseAccountOperationHostAfterDestruction,
  requestAccountOperationHostCleanup,
  reserveAccountOperationHost,
} from "./account-operation-hosts.js";
import type { PrismaClient } from "./client.js";
import { ensureComputerRecord } from "./computers.js";

function lease() {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    userId: "fixture-user",
    spaceId: "fixture-space",
    operationId: "fixture-operation",
    expiresAt: new Date(Date.now() + 60_000),
  };
}
function fixture(computers = 0, accounts = 0) {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    computer: {
      count: vi.fn(async () => computers),
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async () => ({})),
    },
    accountOperationHost: {
      count: vi.fn(async () => accounts),
      create: vi.fn(async ({ data }) => data),
      updateMany: vi.fn(async () => ({ count: 1 })),
      deleteMany: vi.fn(async () => ({ count: 1 })),
      findMany: vi.fn(async () => []),
    },
  };
  const prisma = { ...tx, $transaction: vi.fn(async (fn) => fn(tx)) } as unknown as PrismaClient;
  return { tx, prisma };
}
afterEach(() => vi.unstubAllEnvs());

describe("account operation host quota and cleanup ownership", () => {
  it("reserves an immutable lease before any external allocation", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "2");
    const f = fixture(1, 0);
    const input = lease();
    expect(await reserveAccountOperationHost(f.prisma, input)).toMatchObject(input);
    expect(f.tx.$queryRaw).toHaveBeenCalled();
    expect(f.tx.accountOperationHost.count).toHaveBeenCalledWith({
      where: { userId: input.userId },
    });
    expect(f.tx.accountOperationHost.create).toHaveBeenCalledOnce();
  });

  it.each([
    [1, 1],
    [0, 2],
    [2, 0],
  ])(
    "refuses when %i computers plus %i unresolved account hosts fill quota",
    async (computers, accounts) => {
      vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "2");
      const f = fixture(computers, accounts);
      await expect(reserveAccountOperationHost(f.prisma, lease())).rejects.toThrow("limit");
      expect(f.tx.accountOperationHost.create).not.toHaveBeenCalled();
    },
  );

  it("also counts unresolved account hosts against ordinary bot computer allocation", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "1");
    const f = fixture(0, 1);
    await expect(
      ensureComputerRecord(f.prisma, {
        mode: "dedicated",
        userId: "fixture-user",
        spaceId: "fixture-space",
        botId: "real-bot",
        kind: "docker",
      }),
    ).rejects.toThrow("limit");
    expect(f.tx.computer.upsert).not.toHaveBeenCalled();
  });

  it.each([0, -1, 16 * 60_000, Number.NaN])(
    "rejects invalid TTL %i without touching DB",
    async (ttl) => {
      const f = fixture();
      await expect(
        reserveAccountOperationHost(f.prisma, {
          ...lease(),
          expiresAt: new Date(Date.now() + ttl),
        }),
      ).rejects.toThrow("Invalid");
      expect(f.prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it("marks cleanup pending without deleting or releasing quota", async () => {
    const f = fixture();
    const input = lease();
    expect(await requestAccountOperationHostCleanup(f.prisma, input)).toBe(true);
    expect(f.tx.accountOperationHost.updateMany).toHaveBeenCalledWith({
      where: input,
      data: { cleanupRequestedAt: expect.any(Date) },
    });
    expect(f.tx.accountOperationHost.deleteMany).not.toHaveBeenCalled();
  });

  it("fences confirmed destruction by every immutable ownership field, ignoring extra row fields", async () => {
    const f = fixture();
    const input = lease();
    const row = { ...input, cleanupRequestedAt: null, createdAt: new Date() };
    await releaseAccountOperationHostAfterDestruction(f.prisma, row);
    expect(f.tx.accountOperationHost.deleteMany).toHaveBeenCalledWith({ where: input });
  });

  it("does not replace or silently reuse an already claimed immutable lease", async () => {
    const f = fixture();
    const collision = new Error("synthetic duplicate lease");
    f.tx.accountOperationHost.create.mockRejectedValue(collision);
    await expect(reserveAccountOperationHost(f.prisma, lease())).rejects.toBe(collision);
    expect(f.tx.accountOperationHost.create).toHaveBeenCalledOnce();
    expect(f.tx.accountOperationHost.deleteMany).not.toHaveBeenCalled();
  });

  it("reports a stale destruction fence without changing another lease", async () => {
    const f = fixture();
    f.tx.accountOperationHost.deleteMany.mockResolvedValue({ count: 0 });
    expect(await releaseAccountOperationHostAfterDestruction(f.prisma, lease())).toBe(false);
  });

  it("expiry only lists cleanup work and never releases quota", async () => {
    const f = fixture();
    const now = new Date();
    await listAccountOperationHostsForCleanup(f.prisma, now, 25);
    expect(f.tx.accountOperationHost.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { OR: [{ expiresAt: { lte: now } }, { cleanupRequestedAt: { not: null } }] },
        take: 25,
      }),
    );
    expect(f.tx.accountOperationHost.deleteMany).not.toHaveBeenCalled();
  });
});
