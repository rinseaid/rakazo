import { createHash, randomUUID } from "node:crypto";
import type { AgentRunModel, SecretStore } from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import type { AccountOperationHostDeps } from "./account-operation-host.js";
import { withAccountOperationHost } from "./account-operation-host.js";
import { nativeModelAuth } from "./model-native-credential.js";
import type { NativeAccountDiagnostic } from "./native-account-diagnostics.js";
import { runNativeAccountOperation } from "./native-account-relay.js";
import { LiveCatalogCache } from "./pi-live-cache.js";
import type { NativeModelLoginRunner } from "./pi-oauth.js";
import { parseModelSecret } from "./pi-oauth.js";

/** Existing shared OAuth lifecycle, backed exclusively by a separately owned account host. */
export function createHostedNativeLogin(deps: AccountOperationHostDeps): NativeModelLoginRunner {
  return async (input) => {
    if (input.provider !== "google-antigravity") throw new Error("Unsupported native account");
    const onDiagnostic = (event: NativeAccountDiagnostic) =>
      getLogger().info("native_account_login.stage", event);
    const result = await withAccountOperationHost(
      deps,
      {
        actor: input.actor,
        operationId: input.loginId,
        operation: "model-login",
        signal: input.signal,
        onDiagnostic,
      },
      (process, signal) =>
        runNativeAccountOperation(
          process,
          {
            kind: "login",
            provider: "google-antigravity",
            loginId: input.loginId,
            actor: input.actor,
          },
          input.interaction,
          signal,
          onDiagnostic,
        ),
    );
    if (result.kind !== "login") throw new Error("Invalid native account response");
    return result.secret;
  };
}

export async function discoverHostedNativeModels(
  deps: AccountOperationHostDeps,
  input: {
    actor: { userId: string; spaceId: string };
    operationId: string;
    native: NonNullable<AgentRunModel["nativeAuth"]>;
    signal: AbortSignal;
  },
) {
  if (input.native.provider !== "google-antigravity") throw new Error("Unsupported native account");
  const result = await withAccountOperationHost(
    deps,
    {
      actor: input.actor,
      operationId: input.operationId,
      operation: "model-catalog",
      signal: input.signal,
    },
    (process, signal) =>
      runNativeAccountOperation(
        process,
        { kind: "catalog", provider: "google-antigravity", profile: input.native.profile },
        undefined,
        signal,
      ),
  );
  if (result.kind !== "catalog") throw new Error("Invalid native catalog response");
  input.signal.throwIfAborted();
  // Existing ciphertext/connection fence prevents stale discovery overwriting reconnect/disconnect.
  if (!(await input.native.persist(result.profile))) throw new Error("Native account changed");
  return result.discovery;
}

/** Shared catalog probe resolves the exact caller-owned connection, never a global account cache. */
export function createHostedNativeCatalog(
  deps: AccountOperationHostDeps & { secretStore: SecretStore },
) {
  type CatalogModel = { id: string; thinkingLevels?: string[] };
  const cache = new LiveCatalogCache<CatalogModel>({
    ttlMs: 24 * 60 * 60_000,
    failureTtlMs: 30_000,
    waitMs: 0,
    deadlineMs: 30_000,
    staleMaxAgeMs: 24 * 60 * 60_000,
    maxEntries: 256,
    staleOnError: false,
  });
  const profileRevision = (ciphertext: string) =>
    createHash("sha256").update(ciphertext).digest("base64url");
  const generation = (input: {
    actor: { userId: string; spaceId: string };
    provider: string;
    credentialId: string;
    secretId: string;
    ciphertext: string;
  }) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          input.actor.userId,
          input.actor.spaceId,
          input.provider,
          input.credentialId,
          input.secretId,
          profileRevision(input.ciphertext),
        ]),
      )
      .digest("base64url");
  const cachePrefix = (input: {
    actor: { userId: string; spaceId: string };
    provider: string;
    credentialId?: string;
  }) =>
    input.credentialId
      ? `${JSON.stringify([input.actor.userId, input.actor.spaceId, input.provider, input.credentialId])}`
      : `${JSON.stringify([input.actor.userId, input.actor.spaceId, input.provider]).slice(0, -1)},`;
  const result = (models: CatalogModel[], generation: string) => {
    const thinkingLevelsByModel = Object.fromEntries(
      models.flatMap((model) =>
        model.thinkingLevels?.length ? [[model.id, model.thinkingLevels] as const] : [],
      ),
    );
    return {
      models: models.map((model) => model.id),
      generation,
      ...(Object.keys(thinkingLevelsByModel).length ? { thinkingLevelsByModel } : {}),
    };
  };
  return async (input: {
    actor: { userId: string; spaceId: string };
    provider: string;
    credentialId?: string;
    signal: AbortSignal;
    action?: "discover" | "list" | "validate" | "contains" | "invalidate";
    generation?: string;
    modelId?: string;
    profileRevision?: string;
  }): Promise<{
    models: string[];
    generation: string;
    thinkingLevelsByModel?: Record<string, string[]>;
  }> => {
    const action = input.action ?? "discover";
    if (action === "invalidate") {
      const prefix = cachePrefix(input);
      cache.invalidate(input.credentialId ? `${prefix}:` : prefix);
      return { generation: "", models: [] };
    }
    if (!input.credentialId) throw new Error("Select a native account connection");
    const credentialId = input.credentialId;
    input.signal.throwIfAborted();
    const connection = await deps.prisma.userModelCredential.findFirst({
      where: { id: credentialId, userId: input.actor.userId, provider: input.provider },
      select: { id: true, secretId: true },
    });
    if (!connection) throw new Error("Connection not found");
    const row = await deps.prisma.secret.findFirst({
      where: { id: connection.secretId, userId: input.actor.userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    if (!row) throw new Error("Connection unavailable");
    const secret = parseModelSecret(await deps.secretStore.load(row.ciphertext, row.id));
    if (secret.kind !== "native" || secret.provider !== input.provider)
      throw new Error("Native account sign-in is required");
    const currentGeneration = generation({
      ...input,
      credentialId,
      secretId: row.id,
      ciphertext: row.ciphertext,
    });
    const currentCacheKey = `${cachePrefix(input)}:${currentGeneration}`;
    if (action !== "discover") {
      if (action === "validate" && input.generation !== currentGeneration)
        throw new Error("Native model discovery is stale");
      if (
        action === "contains" &&
        input.profileRevision !== undefined &&
        input.profileRevision !== profileRevision(row.ciphertext)
      )
        throw new Error("Native account revision changed");
      const models = await cache.read(
        currentCacheKey,
        async () => ({ attempted: false as const }),
        0,
      );
      if (!models?.length) throw new Error("Native model discovery expired; list models again");
      if (
        (action === "validate" || action === "contains") &&
        (!input.modelId || !models.some((model) => model.id === input.modelId))
      )
        throw new Error("Choose a model from this account's current discovery");
      return result(models, currentGeneration);
    }
    const native = nativeModelAuth({
      prisma: deps.prisma,
      secretStore: deps.secretStore,
      ...input.actor,
      credentialId: connection.id,
      secretId: row.id,
      ciphertext: row.ciphertext,
      secret,
    });
    const discovery = await discoverHostedNativeModels(deps, {
      actor: input.actor,
      operationId: randomUUID(),
      native,
      signal: input.signal,
    });
    const latest = await deps.prisma.secret.findFirst({
      where: { id: connection.secretId, userId: input.actor.userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    if (!latest || latest.id !== row.id) throw new Error("Native account changed");
    const nextGeneration = generation({
      ...input,
      credentialId,
      secretId: latest.id,
      ciphertext: latest.ciphertext,
    });
    const models = discovery.models.map(({ id, thinkingLevels }) => ({ id, thinkingLevels }));
    if (!models.length) throw new Error("This account has no available models");
    // Discovery is fresh work, so replace any earlier result for this exact profile revision.
    const nextCacheKey = `${cachePrefix(input)}:${nextGeneration}`;
    cache.invalidate(nextCacheKey);
    const cached = await cache.read(
      nextCacheKey,
      async () => ({ attempted: true as const, models }),
      100,
    );
    if (!cached?.length) throw new Error("Native model discovery could not be cached");
    return result(cached, nextGeneration);
  };
}
