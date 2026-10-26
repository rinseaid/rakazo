import type { PrismaClient } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { connectionQuotaPolicy, updateConnectionQuotaPolicy } from "./model-quota-policy.js";

const policy = { enabled: true };
function fixture() {
  const findFirst = vi.fn(async () => ({ id: "connection-a", quotaPolicy: null }));
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = { userModelCredential: { findFirst, updateMany } } as unknown as PrismaClient;
  const ready = vi.fn(async () => true);
  return { prisma, findFirst, updateMany, ready };
}
it("defaults to observation without enabling routing", async () => {
  const f = fixture();
  expect(await connectionQuotaPolicy(f.prisma, "user-a", "connection-a")).toMatchObject({
    enabled: false,
  });
  expect(f.findFirst).toHaveBeenCalledWith({ where: { id: "connection-a", userId: "user-a" } });
});
it("refuses a foreign connection before querying the provider", async () => {
  const f = fixture();
  f.findFirst.mockResolvedValue(null as never);
  await expect(
    updateConnectionQuotaPolicy(f.prisma, "user-a", "foreign", policy, f.ready),
  ).rejects.toMatchObject({ code: "NOT_FOUND" });
  expect(f.ready).not.toHaveBeenCalled();
  expect(f.updateMany).not.toHaveBeenCalled();
});
it("requires fresh verified quota before enabling admission", async () => {
  const f = fixture();
  f.ready.mockResolvedValue(false);
  await expect(
    updateConnectionQuotaPolicy(f.prisma, "user-a", "connection-a", policy, f.ready),
  ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(f.updateMany).not.toHaveBeenCalled();
});
it("can disable admission while the quota reader is unavailable", async () => {
  const f = fixture();
  f.ready.mockRejectedValue(new Error("reader down"));
  const disabled = { ...policy, enabled: false };
  expect(
    await updateConnectionQuotaPolicy(f.prisma, "user-a", "connection-a", disabled, f.ready),
  ).toEqual(disabled);
  expect(f.ready).not.toHaveBeenCalled();
  expect(f.updateMany).toHaveBeenCalledWith({
    where: { id: "connection-a", userId: "user-a" },
    data: { quotaPolicy: disabled },
  });
});

it("discards the obsolete tuning parameters from old saved policy", async () => {
  const f = fixture();
  f.findFirst.mockResolvedValue({
    id: "connection-a",
    quotaPolicy: { enabled: true, requestPercent: 8, reservePercent: 10, uncertaintyPercent: 4 },
  } as never);
  expect(await connectionQuotaPolicy(f.prisma, "user-a", "connection-a")).toEqual({
    enabled: true,
  });
});
