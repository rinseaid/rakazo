import { ORPCError } from "@orpc/server";
import { assertSafeRemoteUrl, createSafeRemoteFetch } from "@rakazo/adapters";
import type { Actor, ModelQuotaWindow } from "@rakazo/contracts";
import {
  CustomUsageConfigSchema as Config,
  CustomUsagePayloadSchema as Payload,
} from "@rakazo/contracts";
import { mayUsePrivateEndpoint } from "./mcp-servers.js";
import type { RouterContext } from "./routes/context.js";
import { computerContext } from "./routes/shared.js";

async function owned(ctx: RouterContext, actor: Actor, credentialId: string) {
  const row = await ctx.deps.prisma.userModelCredential.findFirst({
    where: { id: credentialId, userId: actor.userId },
  });
  if (!row) throw new ORPCError("NOT_FOUND");
  return row;
}

async function load(ctx: RouterContext, row: Awaited<ReturnType<typeof owned>>) {
  if (!row.customUsageSecretId || !row.customUsageCiphertext) return null;
  return Config.parse(
    JSON.parse(await ctx.deps.secrets.load(row.customUsageCiphertext, row.customUsageSecretId)),
  );
}

export async function getCustomUsage(ctx: RouterContext, actor: Actor, credentialId: string) {
  const config = await load(ctx, await owned(ctx, actor, credentialId));
  return { endpoint: config?.endpoint ?? null, hasToken: Boolean(config?.token) };
}

export async function setCustomUsage(
  ctx: RouterContext,
  actor: Actor,
  input: { credentialId: string; endpoint: string | null; token?: string },
) {
  const row = await owned(ctx, actor, input.credentialId);
  if (!input.endpoint) {
    await ctx.deps.prisma.userModelCredential.updateMany({
      where: { id: row.id, userId: actor.userId },
      data: { customUsageSecretId: null, customUsageCiphertext: null },
    });
    return { endpoint: null, hasToken: false };
  }
  let url: URL;
  try {
    url = await assertSafeRemoteUrl(input.endpoint, ctx.deps.remoteConnectors?.resolveHostname, {
      allowPrivateEndpoint: mayUsePrivateEndpoint(ctx.deps),
    });
  } catch {
    throw new ORPCError("BAD_REQUEST", { message: "Usage endpoint is not allowed" });
  }
  const previous = await load(ctx, row);
  const token =
    input.token !== undefined
      ? input.token.trim() || null
      : previous?.endpoint === url.href
        ? previous.token
        : null;
  if (token && url.protocol !== "https:")
    throw new ORPCError("BAD_REQUEST", { message: "A usage token requires HTTPS" });
  const config = { endpoint: url.href, token };
  const sealed = await ctx.deps.secrets.put(
    JSON.stringify(config),
    computerContext(actor, "usage", "model.custom-usage"),
    { ephemeral: true },
  );
  const result = await ctx.deps.prisma.userModelCredential.updateMany({
    where: { id: row.id, userId: actor.userId },
    data: { customUsageSecretId: sealed.id, customUsageCiphertext: sealed.ciphertext },
  });
  if (result.count !== 1) throw new ORPCError("NOT_FOUND");
  return { endpoint: config.endpoint, hasToken: Boolean(config.token) };
}

export function parseCustomUsage(value: unknown): ModelQuotaWindow[] {
  const windows = Payload.parse(value).windows;
  if (new Set(windows.map((window) => window.id)).size !== windows.length)
    throw new Error("duplicate windows");
  return windows.map((window) => ({
    ...window,
    resetsAt: window.resetsAt ?? null,
    modelIds: null,
  }));
}

export async function readCustomUsage(ctx: RouterContext, row: Awaited<ReturnType<typeof owned>>) {
  const checkedAt = new Date().toISOString();
  const empty = {
    credentialId: row.id,
    status: "unavailable" as const,
    checkedAt,
    observedAt: null,
    identityVerified: false,
    windows: [] as ModelQuotaWindow[],
  };
  let fetcher: ReturnType<typeof createSafeRemoteFetch> | undefined;
  try {
    const config = await load(ctx, row);
    if (!config) return { view: empty, poolKey: null };
    if (config.token && new URL(config.endpoint).protocol !== "https:") throw new Error("https");
    fetcher = createSafeRemoteFetch(undefined, ctx.deps.remoteConnectors?.resolveHostname, {
      allowPrivateEndpoint: mayUsePrivateEndpoint(ctx.deps),
    });
    const response = await fetcher(config.endpoint, {
      headers: {
        accept: "application/json",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok || Number(response.headers.get("content-length")) > 65_536 || !response.body)
      throw new Error("response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 65_536) throw new Error("size");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const windows = parseCustomUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    return {
      view: { ...empty, status: "fresh" as const, observedAt: checkedAt, windows },
      poolKey: null,
    };
  } catch {
    return { view: empty, poolKey: null };
  } finally {
    await fetcher?.close().catch(() => undefined);
  }
}
