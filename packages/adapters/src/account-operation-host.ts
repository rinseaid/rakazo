import { randomUUID } from "node:crypto";
import type {
  AccountHostOperation,
  AccountHostProcess,
  AccountOperationLease,
  DuplexProcess,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import {
  ACCOUNT_OPERATION_HOST_MAX_TTL_MS,
  listAccountOperationHostsForCleanup,
  releaseAccountOperationHostAfterDestruction,
  requestAccountOperationHostCleanup,
  reserveAccountOperationHost,
} from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { NativeAccountDiagnostic } from "./native-account-diagnostics.js";

/** Server-only ownership capability for fencing private conversation-state writes. */
export interface AccountOperationProcess extends AccountHostProcess {
  readonly lease: AccountOperationLease;
}

export interface AccountOperationHostDeps {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
}

/** Cleanup is separate from request cancellation and only frees quota after confirmed destruction. */
async function destroyAccountHost(deps: AccountOperationHostDeps, lease: AccountOperationLease) {
  const provider = deps.sandbox.accountOperations;
  if (!provider) throw new Error("Account host cleanup is unavailable");
  await requestAccountOperationHostCleanup(deps.prisma, lease).catch(() => undefined);
  await provider.destroy(lease, AbortSignal.timeout(30_000));
  await releaseAccountOperationHostAfterDestruction(deps.prisma, lease);
}

/**
 * Allocate a genuinely separate account host, not a lease on a bot's computer.
 * No credentials enter this function: they travel only over the returned private stream.
 */
export interface AccountOperationInput {
  actor: { userId: string; spaceId: string };
  operationId: string;
  operation: AccountHostOperation;
  signal: AbortSignal;
  onDiagnostic?: (event: NativeAccountDiagnostic) => void;
}

/** Each invocation owns a distinct immutable lease, including helpers/fallback instances. */
export async function openAccountOperationProcess(
  deps: AccountOperationHostDeps,
  input: AccountOperationInput,
): Promise<AccountOperationProcess> {
  input.signal.throwIfAborted();
  const provider = deps.sandbox.accountOperations;
  if (!provider) throw new Error("Isolated account operations are unavailable on this host");
  const report = (stage: NativeAccountDiagnostic["stage"], durationMs: number) => {
    try {
      input.onDiagnostic?.({ stage, durationMs: Math.max(0, Math.min(900_000, durationMs)) });
    } catch {
      // Diagnostics are bounded observability only and cannot alter account-host cleanup.
    }
  };
  let startedAt = Date.now();
  let capabilities: AccountHostOperation[];
  try {
    capabilities = await provider.capabilities(
      AbortSignal.any([input.signal, AbortSignal.timeout(10_000)]),
    );
  } catch (error) {
    report("account_host_start_failed", Date.now() - startedAt);
    throw error;
  }
  report("account_host_capabilities", Date.now() - startedAt);
  if (!capabilities.includes(input.operation)) {
    report("account_host_start_failed", Date.now() - startedAt);
    throw new Error("This host is not qualified for account operations");
  }
  input.signal.throwIfAborted();
  startedAt = Date.now();
  let lease: AccountOperationLease;
  try {
    lease = await reserveAccountOperationHost(deps.prisma, {
      id: randomUUID(),
      ...input.actor,
      operationId: input.operationId,
      expiresAt: new Date(Date.now() + ACCOUNT_OPERATION_HOST_MAX_TTL_MS),
    });
  } catch (error) {
    report("account_host_start_failed", Date.now() - startedAt);
    throw error;
  }
  report("account_host_reserved", Date.now() - startedAt);
  const signal = AbortSignal.any([
    input.signal,
    AbortSignal.timeout(Math.max(1, lease.expiresAt.getTime() - Date.now())),
  ]);
  let process: AccountHostProcess;
  try {
    signal.throwIfAborted();
    startedAt = Date.now();
    await provider.provision(lease, input.operation, signal);
    report("account_host_provisioned", Date.now() - startedAt);
    signal.throwIfAborted();
    startedAt = Date.now();
    process = await provider.openProcess(lease, signal);
    report("process_stream_ready", Date.now() - startedAt);
    signal.throwIfAborted();
  } catch (error) {
    report("account_host_start_failed", Date.now() - startedAt);
    await destroyAccountHost(deps, lease);
    throw error;
  }
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      signal.removeEventListener("abort", abort);
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        // Do not let a broken stream prevent destruction of its containing isolation boundary.
        await Promise.race([
          process.close(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("Account process cleanup timed out")),
              10_000,
            );
            timer.unref();
          }),
        ]);
      } finally {
        clearTimeout(timer);
        await destroyAccountHost(deps, lease);
      }
    })());
  const abort = () => {
    void close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const expiresAt = lease.expiresAt.getTime();
  const leaseSnapshot = Object.freeze({
    id: lease.id,
    userId: lease.userId,
    spaceId: lease.spaceId,
    operationId: lease.operationId,
    // Date itself is mutable even when frozen. Never expose the internal expiry instance.
    get expiresAt() {
      return new Date(expiresAt);
    },
  });
  const owned: AccountOperationProcess = {
    get lease() {
      return leaseSnapshot;
    },
    events: process.events,
    exited: process.exited,
    write: (bytes) => {
      signal.throwIfAborted();
      if (closing) return Promise.reject(new Error("Account host is closed"));
      return process.write(bytes);
    },
    end: () => process.end(),
    close,
  };
  Object.defineProperty(owned, "lease", { enumerable: false, configurable: false });
  Object.defineProperty(owned, "runtimeIdentity", {
    value: process.runtimeIdentity,
    enumerable: false,
  });
  return owned;
}

export async function withAccountOperationHost<T>(
  deps: AccountOperationHostDeps,
  input: AccountOperationInput,
  run: (process: DuplexProcess, signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const process = await openAccountOperationProcess(deps, input);
  try {
    const value = await run(process, input.signal);
    input.signal.throwIfAborted();
    return value;
  } finally {
    await process.close();
  }
}

/** Called by existing API/worker reconciliation; no volatile timer owns the lease's safety. */
export function createAccountOperationHostSweeper(deps: AccountOperationHostDeps) {
  let running = false;
  return async (): Promise<void> => {
    if (running || !deps.sandbox.accountOperations) return;
    running = true;
    try {
      const leases = await listAccountOperationHostsForCleanup(deps.prisma);
      for (const lease of leases) {
        try {
          await destroyAccountHost(deps, lease);
        } catch {
          // Never log provider errors: diagnostics may contain private account data.
          getLogger().warn("Account operation host cleanup remains pending");
        }
      }
    } finally {
      running = false;
    }
  };
}
