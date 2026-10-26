import { describe, expect, it, vi } from "vitest";
import {
  ModelQuotaReader,
  parseClaudeQuota,
  parseCodexQuota,
  parseGoQuota,
} from "./model-quota.js";

const codex = {
  rate_limit: {
    primary_window: { used_percent: 59, reset_at: 1_900_000_000 },
    secondary_window: null,
  },
  additional_rate_limits: [],
};
const claude = {
  five_hour: { utilization: 0, resets_at: "2030-03-17T12:00:00Z" },
  seven_day: { utilization: 91, resets_at: "2030-03-20T12:00:00Z" },
  seven_day_sonnet: null,
};
const connection = {
  userId: "user-a",
  credentialId: "connection-a",
  provider: "openai-codex",
  revision: "revision-a",
  accessToken: "test-access-token",
  accountId: "test-account",
};
const response = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

describe("model quota observations", () => {
  it("accepts the weekly usage breakdown without treating it as another allowance", () => {
    expect(
      parseClaudeQuota({
        ...claude,
        seven_day_breakdown: { rows: [{ key: "model-a", percent: 91 }] },
        limits: [
          { kind: "session", scope: null, percent: 0 },
          { kind: "weekly_all", scope: null, percent: 91 },
        ],
      }),
    ).toHaveLength(2);
    expect(() =>
      parseClaudeQuota({ ...claude, limits: [{ kind: "unknown_scope", scope: null, percent: 0 }] }),
    ).toThrow();
  });
  it("keeps known zero distinct from unknown and preserves provider resets", () => {
    expect(parseClaudeQuota(claude)).toMatchObject([{ usedPercent: 0 }, { usedPercent: 91 }]);
    expect(parseCodexQuota(codex)).toEqual([
      {
        id: "primary_window",
        usedPercent: 59,
        resetsAt: "2030-03-17T17:46:40.000Z",
        modelIds: null,
      },
    ]);
  });
  it.each([
    null,
    {},
    { rate_limit: {} },
    { rate_limit: { primary_window: { used_percent: -1 } } },
    { rate_limit: { primary_window: { used_percent: 101 } } },
    { ...codex, additional_rate_limits: [{}] },
  ])("rejects incomplete or unknown limiting windows: %j", (value) => {
    expect(() => parseCodexQuota(value)).toThrow();
  });
  it("does not apply an unmapped Claude model window to every model", () => {
    expect(() => parseClaudeQuota({ ...claude, seven_day_sonnet: { utilization: 100 } })).toThrow();
  });
  it("refreshes admission reads instead of reusing the settings cache", async () => {
    let clock = Date.parse("2030-01-01T00:00:00Z");
    const fetcher = vi.fn(async () => {
      const result = response(codex);
      clock += 1000;
      return result;
    });
    const reader = new ModelQuotaReader(fetcher, () => clock);
    const first = await reader.read(connection);
    await reader.read(connection);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const fresh = await reader.read(connection, { fresh: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fresh.view.observedAt).not.toBe(first.view.observedAt);
    expect(fresh.view.observedAt).toBe(new Date(clock - 1000).toISOString());
  });
  it("deduplicates concurrent refreshes and retains a bounded successful cache", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request) => response(codex));
    const reader = new ModelQuotaReader(fetcher);
    const results = await Promise.all(Array.from({ length: 10 }, () => reader.read(connection)));
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(results.every((result) => result.view.status === "fresh")).toBe(true);
    expect(fetcher.mock.calls[0]?.[0]).toBe("https://chatgpt.com/backend-api/wham/usage");
    expect(JSON.stringify(results)).not.toContain("test-access-token");
    expect(JSON.stringify(results)).not.toContain("test-account");
  });
  it("binds two connections for a verified account to one opaque pool", async () => {
    const reader = new ModelQuotaReader(async () => response(codex));
    const first = await reader.read(connection);
    const second = await reader.read({ ...connection, credentialId: "connection-b" });
    const other = await reader.read({ ...connection, userId: "user-b" });
    expect(first.poolKey).toBe(second.poolKey);
    expect(first.poolKey).not.toBe(other.poolKey);
  });
  it("retains the original observation time after failure and invalidates changed credentials", async () => {
    let now = 1_900_000_000_000;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(response(codex))
      .mockRejectedValue(new Error("private provider diagnostic"));
    const reader = new ModelQuotaReader(fetcher, () => now);
    const first = await reader.read(connection);
    now += 61_000;
    const stale = await reader.read(connection);
    expect(stale.view.status).toBe("stale");
    expect(stale.view.observedAt).toBe(first.view.observedAt);
    expect(stale.view.checkedAt).not.toBe(first.view.checkedAt);
    expect(JSON.stringify(stale)).not.toContain("private provider diagnostic");
    const changed = await reader.read({ ...connection, revision: "revision-b" });
    expect(changed.view.status).toBe("unavailable");
    expect(changed.view.observedAt).toBeNull();
  });
  it("never dispatches for unsupported, expired or unidentified Codex accounts", async () => {
    const fetcher = vi.fn();
    const reader = new ModelQuotaReader(fetcher);
    expect((await reader.read({ ...connection, provider: "other" })).view.status).toBe(
      "unsupported",
    );
    expect((await reader.read({ ...connection, accessToken: null })).view.status).toBe(
      "unavailable",
    );
    expect((await reader.read({ ...connection, accountId: undefined })).view.identityVerified).toBe(
      false,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("verifies Claude pool identity without exposing profile fields", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      response(
        String(url).endsWith("/profile")
          ? {
              account: { uuid: "account-a", email: "private@example.test" },
              organization: { uuid: "org-a" },
            }
          : claude,
      ),
    );
    const result = await new ModelQuotaReader(fetcher).read({
      ...connection,
      provider: "anthropic",
    });
    expect(result.view).toMatchObject({ status: "fresh", identityVerified: true });
    expect(result.view.windows).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("private@example.test");
    expect(JSON.stringify(result)).not.toContain("account-a");
  });
  it("rejects oversized responses without returning a partial quota", async () => {
    const result = await new ModelQuotaReader(async () => new Response(" ".repeat(65_537))).read(
      connection,
    );
    expect(result.view.status).toBe("unavailable");
    expect(result.view.windows).toEqual([]);
  });
  it("keeps HTTP failures unavailable and blocks redirects", async () => {
    const fetcher = vi.fn(async (_url: string | URL | Request, options?: RequestInit) => {
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeInstanceOf(AbortSignal);
      return new Response("private error", { status: 401 });
    });
    expect((await new ModelQuotaReader(fetcher).read(connection)).view.status).toBe("unavailable");
  });
});

const go = {
  usage: {
    rolling: { status: "ok", percent: 0, resetsAt: "2030-03-17T17:00:00Z" },
    weekly: { status: "ok", percent: 54, resetsAt: "2030-03-20T12:00:00Z" },
    monthly: { status: "rate-limited", percent: 100, resetsAt: "2030-04-01T12:00:00Z" },
  },
};
it("reads all Go windows from the exact saved key without claiming a verified account pool", async () => {
  const fetcher = vi.fn(async () => response(go));
  const result = await new ModelQuotaReader(fetcher).read({
    ...connection,
    provider: "opencode-go",
    accountId: undefined,
  });
  expect(fetcher).toHaveBeenCalledWith(
    "https://opencode.ai/zen/go/v1/usage",
    expect.objectContaining({
      headers: expect.objectContaining({ authorization: "Bearer test-access-token" }),
      redirect: "error",
    }),
  );
  expect(result.view).toMatchObject({
    status: "fresh",
    identityVerified: false,
    windows: [
      { id: "five_hour", usedPercent: 0 },
      { id: "seven_day", usedPercent: 54 },
      { id: "monthly", usedPercent: 100 },
    ],
  });
  expect(result.poolKey).toBeNull();
  expect(JSON.stringify(result)).not.toContain("test-access-token");
});
it("rejects incomplete and unknown Go windows", () => {
  expect(() => parseGoQuota({ usage: { ...go.usage, monthly: null } })).toThrow();
  expect(() =>
    parseGoQuota({ usage: { ...go.usage, monthly: { ...go.usage.monthly, status: "unknown" } } }),
  ).toThrow();
  expect(() => parseGoQuota({ usage: { ...go.usage, extra: go.usage.weekly } })).toThrow();
});
