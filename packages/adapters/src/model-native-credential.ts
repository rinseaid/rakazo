import type { AgentRunModel, SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { StoredModelSecret } from "./pi-oauth.js";
import { secretValuesToRedact, serializeModelSecret, withModelCredentialLock } from "./pi-oauth.js";

/** An in-process capability, bound to the exact authorized connection and secret version. */
export function nativeModelAuth(input: {
  prisma: Pick<PrismaClient, "$transaction">;
  secretStore: Pick<SecretStore, "put" | "delete">;
  userId: string;
  spaceId: string;
  credentialId: string;
  secretId: string;
  ciphertext: string;
  secret: Extract<StoredModelSecret, { kind: "native" }>;
  registerSecrets?: (values: string[]) => void;
}): NonNullable<AgentRunModel["nativeAuth"]> {
  let expectedCiphertext = input.ciphertext;
  const capability: NonNullable<AgentRunModel["nativeAuth"]> = {
    provider: input.secret.provider,
    profile: input.secret.profile,
    persist: async (profile) =>
      withModelCredentialLock(input.secretId, async () => {
        const next = { ...input.secret, profile };
        const serialized = serializeModelSecret(next);
        input.registerSecrets?.(secretValuesToRedact(next));
        const stored = await input.secretStore.put(
          serialized,
          {
            operationId: "cred",
            traceId: "native-profile-refresh",
            spaceId: input.spaceId,
            userId: input.userId,
            signal: new AbortController().signal,
          },
          { recordId: input.secretId },
        );
        const previousRef = expectedCiphertext;
        // A thrown transaction may already have committed: do not clean either ref then.
        const saved = await input.prisma.$transaction(async (tx) => {
          // Lock and verify the original connection before writing its secret.
          const connection = await tx.userModelCredential.updateMany({
            where: {
              id: input.credentialId,
              userId: input.userId,
              provider: input.secret.provider,
              secretId: input.secretId,
            },
            data: { secretId: input.secretId },
          });
          if (connection.count !== 1) return false;
          const updated = await tx.secret.updateMany({
            where: {
              id: input.secretId,
              userId: input.userId,
              spaceId: null,
              ciphertext: expectedCiphertext,
            },
            data: { ciphertext: stored.ciphertext },
          });
          return updated.count === 1;
        });
        if (saved) expectedCiphertext = stored.ciphertext;
        const obsoleteRef = saved ? previousRef : stored.ref;
        // A provider returning the same reference has not allocated an obsolete resource.
        if (previousRef !== stored.ref && previousRef !== stored.ciphertext) {
          try {
            await input.secretStore.delete(obsoleteRef, {
              recordId: input.secretId,
              signal: AbortSignal.timeout(2_000),
            });
          } catch {
            // Never report a committed refresh as failed, or log backend errors containing refs.
            getLogger().warn("Native account profile secret cleanup did not complete");
          }
        }
        return saved;
      }),
  };
  // Credential material is accessible to the scoped runtime, not generic JSON logs/checkpoints.
  Object.defineProperty(capability, "profile", { enumerable: false });
  Object.defineProperty(capability, "accountGeneration", {
    value: input.secretId,
    enumerable: false,
  });
  return capability;
}
