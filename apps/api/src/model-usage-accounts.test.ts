import { describe, expect, it, vi } from "vitest";
import { setConnectionUsageAccounts } from "./model-usage-accounts.js";
import type { RouterContext } from "./routes/context.js";

function fixture() {
  const gateway = {
    id: "gateway",
    userId: "owner",
    provider: "openai-compatible",
    secretId: "gateway-secret",
    usageGateways: [] as Array<{ credentialId: string }>,
  };
  const account = {
    id: "account",
    userId: "owner",
    provider: "opencode-go",
    label: "Upstream",
    secretId: "account-secret",
    usageAccounts: [] as Array<{ usageAccountId: string }>,
  };
  const tx = {
    userModelCredential: {
      findFirst: vi.fn(async () => gateway),
      findMany: vi.fn(async () => [account]),
    },
    secret: {
      findFirst: vi.fn(async () => ({ id: "account-secret", ciphertext: "test-ciphertext" })),
    },
    userModelUsageAccount: {
      deleteMany: vi.fn(async () => ({})),
      createMany: vi.fn(async () => ({})),
    },
  };
  const prisma = { $transaction: vi.fn(async (callback) => callback(tx)) };
  const load = vi.fn(async () => JSON.stringify({ kind: "api_key", key: "test-upstream-key" }));
  const ctx = { deps: { prisma, secrets: { load } } } as unknown as RouterContext;
  const save = (ids = ["account"]) => setConnectionUsageAccounts(ctx, "owner", "gateway", ids);
  return { gateway, account, tx, prisma, load, save };
}

describe("owned read-only usage links", () => {
  it("stores one deduplicated link without reading or changing gateway credentials or routing", async () => {
    const f = fixture();
    await expect(f.save(["account", "account"])).resolves.toEqual({ usageAccountIds: ["account"] });
    expect(f.tx.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "account-secret", userId: "owner", spaceId: null },
    });
    expect(f.tx.userModelUsageAccount.createMany).toHaveBeenCalledWith({
      data: [{ credentialId: "gateway", usageAccountId: "account", userId: "owner" }],
    });
    expect(f.tx.userModelCredential.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ["account"] }, userId: "owner" } }),
    );
  });
  it("does not read secrets for a missing or foreign gateway", async () => {
    const f = fixture();
    f.tx.userModelCredential.findFirst.mockResolvedValue(null as never);
    await expect(f.save()).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.tx.userModelUsageAccount.deleteMany).not.toHaveBeenCalled();
  });
  it("rejects foreign upstreams before reading secrets or deleting existing links", async () => {
    const f = fixture();
    f.tx.userModelCredential.findMany.mockResolvedValue([]);
    await expect(f.save()).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.tx.userModelUsageAccount.deleteMany).not.toHaveBeenCalled();
  });
  it.each(["self", "chain", "reverse-chain"])("rejects %s links", async (kind) => {
    const f = fixture();
    if (kind === "chain") f.account.usageAccounts = [{ usageAccountId: "next" }];
    if (kind === "reverse-chain") f.gateway.usageGateways = [{ credentialId: "previous" }];
    await expect(f.save(kind === "self" ? ["gateway"] : ["account"])).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(f.tx.userModelUsageAccount.deleteMany).not.toHaveBeenCalled();
  });
  it("refuses unreadable accounts without exposing credential errors", async () => {
    const f = fixture();
    f.load.mockRejectedValue(new Error("private ciphertext diagnostic"));
    await expect(f.save()).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Usage account not available",
    });
    expect(f.tx.userModelUsageAccount.deleteMany).not.toHaveBeenCalled();
  });
  it("can unlink without a working upstream credential", async () => {
    const f = fixture();
    f.tx.userModelCredential.findMany.mockResolvedValue([]);
    await expect(f.save([])).resolves.toEqual({ usageAccountIds: [] });
    expect(f.tx.userModelUsageAccount.deleteMany).toHaveBeenCalledWith({
      where: { credentialId: "gateway", userId: "owner" },
    });
    expect(f.load).not.toHaveBeenCalled();
    expect(f.tx.userModelUsageAccount.createMany).not.toHaveBeenCalled();
  });
});
