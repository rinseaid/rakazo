import type {
  AccountHostOperation,
  AccountHostProcess,
  AccountOperationHostProvider,
  AccountOperationLease,
} from "@rakazo/adapter-kit";
import { openHttpProcess } from "./duplex-process.js";
import { readBodyCapped } from "./web-ssrf.js";

/** Separate authenticated supervisor namespace; never a ComputerRef or bot filesystem. */
export function dockerAccountOperations(
  supervisorUrl: string,
  supervisorToken: string,
): AccountOperationHostProvider {
  const url = (suffix: string) => `${supervisorUrl.replace(/\/$/, "")}/account-hosts${suffix}`;
  const headers = (lease?: AccountOperationLease) => ({
    authorization: `Bearer ${supervisorToken}`,
    ...(lease
      ? {
          "x-rakazo-user-id": lease.userId,
          "x-rakazo-space-id": lease.spaceId,
          "x-rakazo-operation-id": lease.operationId,
          "x-rakazo-lease-id": lease.id,
          "x-rakazo-expires-at": lease.expiresAt.toISOString(),
        }
      : {}),
  });
  const hostPath = (lease: AccountOperationLease) => {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(lease.id))
      throw new Error("Invalid account host lease");
    return `/rakazo-account-${lease.id}`;
  };
  async function checked(response: Response): Promise<void> {
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error("Isolated account host is unavailable");
  }
  return {
    async capabilities(signal) {
      const response = await fetch(url("/capabilities"), { headers: headers(), signal });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return [];
      }
      const bytes = await readBodyCapped(response, 4096, signal);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (!value || typeof value !== "object") return [];
      const capability = value as { supported?: unknown; operations?: unknown };
      if (capability.supported !== true || !Array.isArray(capability.operations)) return [];
      return capability.operations.filter(
        (operation): operation is AccountHostOperation =>
          operation === "model" || operation === "model-login" || operation === "model-catalog",
      );
    },
    async provision(lease, operation, signal) {
      hostPath(lease);
      await checked(
        await fetch(url(""), {
          method: "POST",
          headers: { ...headers(lease), "content-type": "application/json" },
          body: JSON.stringify({
            userId: lease.userId,
            spaceId: lease.spaceId,
            operationId: lease.operationId,
            leaseId: lease.id,
            expiresAt: lease.expiresAt.toISOString(),
            operation,
          }),
          signal,
        }),
      );
    },
    async openProcess(lease, signal) {
      // The supervisor selects the fixed helper; arbitrary argv/env/cwd are forbidden.
      let runtimeIdentity: string | undefined;
      const process: AccountHostProcess = await openHttpProcess(
        url(`${hostPath(lease)}/process`),
        headers(lease),
        { argv: [] },
        signal,
        {
          onResponseHeaders: (headers) => {
            const imageId = headers.get("x-rakazo-account-image-id");
            if (imageId === null) return; // Older hosts remain usable without durable reuse.
            if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
              throw new Error("Invalid private host runtime identity");
            runtimeIdentity = `docker-image:${imageId}`;
          },
        },
      );
      Object.defineProperty(process, "runtimeIdentity", {
        value: runtimeIdentity,
        enumerable: false,
      });
      return process;
    },
    async destroy(lease, signal) {
      const response = await fetch(url(hostPath(lease)), {
        method: "DELETE",
        headers: headers(lease),
        signal,
      });
      // Only an authenticated owner-aware successful delete confirms cleanup. A 404 could
      // mean an unsupported supervisor route, not proof that an allocation is absent.
      await checked(response);
    },
  };
}
