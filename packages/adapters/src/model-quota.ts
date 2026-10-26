import { createHash } from "node:crypto";
import type { ModelQuota, ModelQuotaWindow } from "@rakazo/contracts";

const MAX_BYTES = 64 * 1024;
const MAX_AGE_MS = 60_000;
const FAILURE_TTL_MS = 15_000;
const MAX_ENTRIES = 256;

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("schema");
  return value as ObjectValue;
}
function percent(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100)
    throw new Error("schema");
  return value;
}
function reset(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const time =
    typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  if (!Number.isFinite(time) || time < 0) throw new Error("schema");
  return new Date(time).toISOString();
}

/** Parse only applicable provider windows; a missing required window is unknown. */
export function parseCodexQuota(payload: unknown): ModelQuotaWindow[] {
  const body = object(payload);
  const limits = object(body.rate_limit);
  const windows: ModelQuotaWindow[] = [];
  for (const key of ["primary_window", "secondary_window"]) {
    const raw = limits[key];
    if (raw === null || raw === undefined) continue;
    const window = object(raw);
    windows.push({
      id: key,
      usedPercent: percent(window.used_percent),
      resetsAt: reset(window.reset_at),
      modelIds: null,
    });
  }
  if (!windows.length) throw new Error("schema");
  // Additional buckets can constrain particular models. Do not silently discard
  // unknown bucket shapes and report an apparently complete allowance.
  if (
    body.additional_rate_limits !== undefined &&
    body.additional_rate_limits !== null &&
    (!Array.isArray(body.additional_rate_limits) || body.additional_rate_limits.length > 0)
  )
    throw new Error("schema");
  return windows;
}

export function parseClaudeQuota(payload: unknown): ModelQuotaWindow[] {
  const body = object(payload);
  const windows: ModelQuotaWindow[] = [];
  for (const key of ["five_hour", "seven_day"]) {
    const window = object(body[key]);
    windows.push({
      id: key,
      usedPercent: percent(window.utilization),
      resetsAt: reset(window.resets_at),
      modelIds: null,
    });
  }
  // Model-specific windows must not gate unrelated models. Until the provider
  // supplies an unambiguous model mapping, report this observation unavailable.
  for (const [key, value] of Object.entries(body)) {
    if (
      key.startsWith("seven_day_") &&
      key !== "seven_day_breakdown" &&
      value !== null &&
      value !== undefined
    )
      throw new Error("schema");
  }
  if (body.limits !== undefined) {
    if (!Array.isArray(body.limits)) throw new Error("schema");
    for (const raw of body.limits) {
      const limit = object(raw);
      const id =
        limit.kind === "session" ? "five_hour" : limit.kind === "weekly_all" ? "seven_day" : null;
      if (
        !id ||
        limit.scope !== null ||
        percent(limit.percent) !== windows.find((window) => window.id === id)?.usedPercent
      )
        throw new Error("schema");
    }
  }
  return windows;
}

export type QuotaConnection = {
  userId: string;
  credentialId: string;
  provider: string;
  /** Changes whenever encrypted credential material changes. Never returned to clients. */
  revision: string;
  accessToken: string | null;
  accountId?: string;
};
export type QuotaRead = { view: ModelQuota; poolKey: string | null };

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error("http");
  }
  if (Number(response.headers.get("content-length")) > MAX_BYTES) {
    await response.body?.cancel();
    throw new Error("size");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("body");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > MAX_BYTES) throw new Error("size");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Read-only, bounded readers. Authentication and refresh remain with the caller. */
export class ModelQuotaReader {
  private readonly cache = new Map<string, { read: QuotaRead; retryAt: number }>();
  private readonly pending = new Map<string, Promise<QuotaRead>>();
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = Date.now,
  ) {}

  async read(connection: QuotaConnection): Promise<QuotaRead> {
    const supported = ["openai-codex", "anthropic"].includes(connection.provider);
    const empty: QuotaRead = {
      view: {
        credentialId: connection.credentialId,
        status: supported ? "unavailable" : "unsupported",
        observedAt: null,
        checkedAt: new Date(this.now()).toISOString(),
        identityVerified: false,
        windows: [],
      },
      poolKey: null,
    };
    if (!supported || !connection.accessToken) return empty;
    const revision = createHash("sha256").update(connection.revision).digest("hex");
    const key = JSON.stringify([
      connection.userId,
      connection.provider,
      connection.credentialId,
      revision,
    ]);
    const cached = this.cache.get(key);
    if (cached && cached.retryAt > this.now()) return cached.read;
    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight;
    const task = this.refresh(connection, empty, cached?.read).finally(() =>
      this.pending.delete(key),
    );
    this.pending.set(key, task);
    return task;
  }

  private async refresh(
    connection: QuotaConnection,
    empty: QuotaRead,
    previous?: QuotaRead,
  ): Promise<QuotaRead> {
    const revision = createHash("sha256").update(connection.revision).digest("hex");
    const key = JSON.stringify([
      connection.userId,
      connection.provider,
      connection.credentialId,
      revision,
    ]);
    let read = empty;
    try {
      const codex = connection.provider === "openai-codex";
      if (codex && !connection.accountId) throw new Error("identity");
      const headers: Record<string, string> = {
        authorization: `Bearer ${connection.accessToken}`,
        accept: "application/json",
      };
      if (codex) headers["chatgpt-account-id"] = connection.accountId!;
      else headers["anthropic-beta"] = "oauth-2025-04-20";
      const get = async (url: string) =>
        jsonResponse(
          await this.fetchImpl(url, {
            headers,
            redirect: "error",
            signal: AbortSignal.timeout(10_000),
          }),
        );
      const payload = await get(
        codex
          ? "https://chatgpt.com/backend-api/wham/usage"
          : "https://api.anthropic.com/api/oauth/usage",
      );
      let accountId = connection.accountId;
      if (!codex) {
        const profile = object(await get("https://api.anthropic.com/api/oauth/profile"));
        const account = object(profile.account);
        const organization = object(profile.organization);
        if (
          typeof account.uuid !== "string" ||
          !account.uuid ||
          typeof organization.uuid !== "string" ||
          !organization.uuid
        )
          throw new Error("identity");
        accountId = JSON.stringify([organization.uuid, account.uuid]);
      }
      read = {
        view: {
          ...empty.view,
          status: "fresh",
          observedAt: new Date(this.now()).toISOString(),
          identityVerified: true,
          windows: codex ? parseCodexQuota(payload) : parseClaudeQuota(payload),
        },
        poolKey: createHash("sha256")
          .update(JSON.stringify([connection.userId, connection.provider, accountId]))
          .digest("hex"),
      };
    } catch {
      // Provider errors can contain tokens and account identifiers. Preserve only
      // the last good observation with its original timestamp, never the body.
      if (previous?.view.observedAt)
        read = {
          ...previous,
          view: { ...previous.view, status: "stale", checkedAt: empty.view.checkedAt },
        };
    }
    if (this.cache.size >= MAX_ENTRIES) this.cache.delete(this.cache.keys().next().value!);
    this.cache.set(key, {
      read,
      retryAt: this.now() + (read.view.status === "fresh" ? MAX_AGE_MS : FAILURE_TTL_MS),
    });
    return read;
  }
}
