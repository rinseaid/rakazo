import type { DuplexProcess, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createAccountOperationHostSweeper,
  openAccountOperationProcess,
  withAccountOperationHost,
} from "./account-operation-host.js";

const db = vi.hoisted(() => ({
  reserve: vi.fn(),
  cleanup: vi.fn(),
  release: vi.fn(),
  list: vi.fn(),
}));
vi.mock("@rakazo/db", () => ({
  ACCOUNT_OPERATION_HOST_MAX_TTL_MS: 15 * 60_000,
  reserveAccountOperationHost: db.reserve,
  requestAccountOperationHostCleanup: db.cleanup,
  releaseAccountOperationHostAfterDestruction: db.release,
  listAccountOperationHostsForCleanup: db.list,
}));
const actor = { userId: "fixture-user", spaceId: "fixture-space" };
const lease = {
  id: "94c60586-cd4d-4309-ae5a-df606ad7ee1b",
  ...actor,
  operationId: "fixture-operation",
  expiresAt: new Date(Date.now() + 900_000),
};
function fixture() {
  const process = {
    close: vi.fn().mockResolvedValue(undefined),
    events: [],
    exited: Promise.resolve({ code: 0 }),
  } as unknown as DuplexProcess;
  const accountOperations = {
    capabilities: vi.fn().mockResolvedValue(["model-login", "model-catalog"]),
    provision: vi.fn().mockResolvedValue(undefined),
    openProcess: vi.fn().mockResolvedValue(process),
    destroy: vi.fn().mockResolvedValue(undefined),
  };
  const deps = {
    prisma: {} as PrismaClient,
    sandbox: { accountOperations } as unknown as SandboxProvider,
  };
  const input = {
    actor,
    operationId: "fixture-operation",
    operation: "model-login" as const,
    signal: new AbortController().signal,
  };
  return { deps, input, accountOperations, process };
}
beforeEach(() => {
  vi.resetAllMocks();
  db.reserve.mockImplementation(async (_, value) => value);
  db.cleanup.mockResolvedValue(true);
  db.release.mockResolvedValue(true);
});
describe("private account operation lifecycle", () => {
  it("preserves a private immutable snapshot of the transport-attested runtime identity", async () => {
    const f = fixture();
    const identity = `docker-image:sha256:${"a".repeat(64)}`;
    Object.defineProperty(f.process, "runtimeIdentity", { value: identity, writable: true });
    const owned = await openAccountOperationProcess(f.deps, f.input);
    Object.defineProperty(f.process, "runtimeIdentity", { value: "later-mutation" });
    expect(owned.runtimeIdentity).toBe(identity);
    expect(Object.keys(owned)).not.toContain("runtimeIdentity");
    expect(Object.getOwnPropertyDescriptor(owned, "runtimeIdentity")).toMatchObject({
      writable: false,
      configurable: false,
    });
    await owned.close();
  });
  it("reserves actor quota before allocation and destroys before returning credentials", async () => {
    const f = fixture();
    const run = vi.fn().mockResolvedValue("fixture-result");
    expect(await withAccountOperationHost(f.deps, f.input, run)).toBe("fixture-result");
    const allocated = db.reserve.mock.calls[0]![1];
    expect(allocated).toMatchObject({ ...actor, operationId: "fixture-operation" });
    expect(allocated).not.toHaveProperty("botId");
    expect(allocated.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 900_000);
    expect(db.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      f.accountOperations.provision.mock.invocationCallOrder[0]!,
    );
    expect(f.accountOperations.destroy.mock.invocationCallOrder[0]).toBeLessThan(
      db.release.mock.invocationCallOrder[0]!,
    );
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ events: f.process.events }),
      expect.any(AbortSignal),
    );
  });
  it("reports only fixed account-host startup stages", async () => {
    const f = fixture();
    const diagnostics: Array<{ stage: string; durationMs: number }> = [];
    const owned = await openAccountOperationProcess(f.deps, {
      ...f.input,
      onDiagnostic: (event) => diagnostics.push(event),
    });
    await owned.close();
    expect(diagnostics.map((event) => event.stage)).toEqual([
      "account_host_capabilities",
      "account_host_reserved",
      "account_host_provisioned",
      "process_stream_ready",
    ]);
    expect(diagnostics.every((event) => Number.isSafeInteger(event.durationMs))).toBe(true);
  });
  it("reports host allocation failure without forwarding error text", async () => {
    const f = fixture();
    db.reserve.mockRejectedValue(new Error("fixture-private-reservation-error"));
    const diagnostics: Array<Record<string, unknown>> = [];
    await expect(
      openAccountOperationProcess(f.deps, {
        ...f.input,
        onDiagnostic: (event) => diagnostics.push(event),
      }),
    ).rejects.toThrow("fixture-private-reservation-error");
    expect(diagnostics.at(-1)).toEqual({
      stage: "account_host_start_failed",
      durationMs: expect.any(Number),
    });
    expect(JSON.stringify(diagnostics)).not.toContain("fixture-private-reservation-error");
  });
  it("does not reserve or allocate an unsupported host", async () => {
    const f = fixture();
    f.accountOperations.capabilities.mockResolvedValue([]);
    await expect(withAccountOperationHost(f.deps, f.input, vi.fn())).rejects.toThrow(
      "not qualified",
    );
    expect(db.reserve).not.toHaveBeenCalled();
    expect(f.accountOperations.provision).not.toHaveBeenCalled();
  });
  it("destroys uncertain allocations using their original fence", async () => {
    const f = fixture();
    f.accountOperations.provision.mockRejectedValue(new Error("transport lost"));
    await expect(withAccountOperationHost(f.deps, f.input, vi.fn())).rejects.toThrow(
      "transport lost",
    );
    expect(f.accountOperations.destroy).toHaveBeenCalledWith(
      db.reserve.mock.calls[0]![1],
      expect.any(AbortSignal),
    );
    expect(db.release).toHaveBeenCalledOnce();
  });
  it("never releases quota or returns a successful result when destruction is uncertain", async () => {
    const f = fixture();
    f.accountOperations.destroy.mockRejectedValue(new Error("cleanup incomplete"));
    await expect(withAccountOperationHost(f.deps, f.input, async () => "result")).rejects.toThrow(
      "cleanup incomplete",
    );
    expect(db.cleanup).toHaveBeenCalledOnce();
    expect(db.release).not.toHaveBeenCalled();
  });
  it("uses a fresh cleanup signal after request cancellation", async () => {
    const f = fixture();
    const abort = new AbortController();
    f.input.signal = abort.signal;
    await expect(
      withAccountOperationHost(f.deps, f.input, async () => {
        abort.abort();
        return "result";
      }),
    ).rejects.toThrow();
    expect(f.accountOperations.destroy.mock.calls[0]![1].aborted).toBe(false);
    expect(db.release).toHaveBeenCalledOnce();
  });
  it("gives helper/fallback opens distinct immutable leases and closes each exactly once", async () => {
    const f = fixture();
    f.accountOperations.capabilities.mockResolvedValue(["model"]);
    const first = await openAccountOperationProcess(f.deps, { ...f.input, operation: "model" });
    const second = await openAccountOperationProcess(f.deps, { ...f.input, operation: "model" });
    expect(db.reserve.mock.calls[0]![1].id).not.toBe(db.reserve.mock.calls[1]![1].id);
    await Promise.all([first.close(), first.close(), second.close(), second.close()]);
    expect(f.accountOperations.destroy).toHaveBeenCalledTimes(2);
    expect(db.release).toHaveBeenCalledTimes(2);
  });

  it("exposes an immutable server-only lease without serializing ownership", async () => {
    const f = fixture();
    const process = await openAccountOperationProcess(f.deps, f.input);
    const reserved = db.reserve.mock.calls[0]![1];
    expect(process.lease).toEqual(reserved);
    expect(process.lease).not.toBe(reserved);
    expect(Object.keys(process)).not.toContain("lease");
    expect(JSON.stringify(process)).not.toContain(reserved.id);
    expect(Object.getOwnPropertyDescriptor(process, "lease")).toMatchObject({
      enumerable: false,
      configurable: false,
      set: undefined,
    });
    expect(Object.isFrozen(process.lease)).toBe(true);
    expect(() => Object.assign(process.lease, { id: "different-lease" })).toThrow();
    expect(() => Object.defineProperty(process, "lease", { value: reserved })).toThrow();
    const expiry = reserved.expiresAt.getTime();
    process.lease.expiresAt.setTime(0);
    expect(process.lease.expiresAt.getTime()).toBe(expiry);
    expect(reserved.expiresAt.getTime()).toBe(expiry);
    await process.close();
    expect(f.accountOperations.destroy).toHaveBeenCalledWith(reserved, expect.any(AbortSignal));
  });

  it("does nothing for pre-cancelled input", async () => {
    const f = fixture();
    f.input.signal = AbortSignal.abort();
    await expect(withAccountOperationHost(f.deps, f.input, vi.fn())).rejects.toThrow();
    expect(f.accountOperations.capabilities).not.toHaveBeenCalled();
  });
  it("sweeps expired/cleanup-pending hosts without requiring image qualification", async () => {
    const f = fixture();
    db.list.mockResolvedValue([lease]);
    await createAccountOperationHostSweeper(f.deps)();
    expect(f.accountOperations.capabilities).not.toHaveBeenCalled();
    expect(f.accountOperations.destroy).toHaveBeenCalledWith(lease, expect.any(AbortSignal));
    expect(db.release).toHaveBeenCalledWith(f.deps.prisma, lease);
  });
});
