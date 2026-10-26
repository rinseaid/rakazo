import type { ModelCallObserver, SecretStore } from "@rakazo/adapter-kit";
import { SubscriptionQuotaDeclinedError } from "@rakazo/adapter-kit";
import { ModelQuotaPolicySchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { reserveSubscriptionQuota, settleSubscriptionQuota } from "@rakazo/db";
import { ModelQuotaReader } from "./model-quota.js";
import { loadStoredModelSecret } from "./model-selection.js";
import {
  kickModelCredentialRefresh,
  oauthCredentialAccountId,
  parseModelSecret,
} from "./pi-oauth.js";
import { dispatcherFetch } from "./undici-fetch.js";

const quotaReader = new ModelQuotaReader(dispatcherFetch);

/** An opt-in observer for personal connections; hosted dollar billing is unchanged. */
export function subscriptionQuotaObserver(
  deps: { prisma: PrismaClient; secretStore: Pick<SecretStore, "load" | "put"> },
  scope: { userId: string; spaceId: string },
  credential: { id: string; quotaPolicy?: unknown },
  reader = quotaReader,
): ModelCallObserver | undefined {
  const policy = ModelQuotaPolicySchema.parse(credential.quotaPolicy ?? {});
  if (!policy.enabled) return undefined;
  const reservations = new Map<string, string>();
  return {
    async beforeCall(call) {
      const row = await deps.prisma.userModelCredential.findFirst({
        where: { id: credential.id, userId: scope.userId },
      });
      if (!row) throw new Error("Model connection is unavailable");
      const stored = await loadStoredModelSecret(
        deps.prisma,
        deps.secretStore,
        scope.userId,
        row.secretId,
      );
      let accessToken: string | null = null;
      let accountId: string | undefined;
      if (stored.status === "loaded") {
        const secret = parseModelSecret(stored.plaintext);
        if (secret.kind === "oauth") {
          if (secret.credential.expires > Date.now() + 30_000) {
            accessToken = secret.credential.access;
            accountId = oauthCredentialAccountId(secret.credential);
          } else
            kickModelCredentialRefresh(
              deps.prisma,
              deps.secretStore,
              scope,
              row.secretId,
              row.provider,
            );
        }
      }
      const read = await reader.read(
        {
          userId: scope.userId,
          credentialId: row.id,
          provider: row.provider,
          revision: stored.status === "loaded" ? stored.ciphertext : row.secretId,
          accessToken,
          accountId,
        },
        { fresh: true },
      );
      if (!read.poolKey || read.view.status !== "fresh")
        throw new SubscriptionQuotaDeclinedError(
          read.view.status,
          new Date(Date.now() + 60_000).toISOString(),
        );
      if (!call.callId) throw new Error("Model call identity is unavailable");
      if (!call.runId || !call.runLease) throw new Error("Model execution lease is unavailable");
      const result = await reserveSubscriptionQuota(
        deps.prisma,
        scope.userId,
        read.poolKey,
        read.view,
        {
          id: call.callId,
          modelId: call.modelId,
          owner: {
            runId: call.runId,
            leaseOwner: call.runLease.owner,
            leaseFence: call.runLease.fence,
          },
          now: Date.now(),
        },
      );
      if (result.kind === "declined")
        throw new SubscriptionQuotaDeclinedError(result.reason, result.retryAt);
      reservations.set(result.reservationId, read.poolKey);
      return result.reservationId;
    },
    async afterCall(id, usage) {
      const poolKey = reservations.get(id);
      if (!poolKey) throw new Error("Quota reservation is unavailable");
      await settleSubscriptionQuota(
        deps.prisma,
        scope.userId,
        poolKey,
        id,
        usage?.usageSource === "not-started" || usage?.usageSource === "provider-rejected",
      );
      reservations.delete(id);
    },
  };
}
