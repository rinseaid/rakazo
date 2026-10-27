import type { AgentRunModel, AgentRunRequest, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createAccountModelProvider } from "./google-acp-remote.js";

const boundary = vi.hoisted(() => ({ open: vi.fn(), factory: vi.fn(), relay: vi.fn() }));
vi.mock("./account-operation-host.js", () => ({ openAccountOperationProcess: boundary.open }));
vi.mock("./pi-acp-provider.js", () => ({ createHostedAcpProvider: boundary.factory }));
vi.mock("./acp-run-relay.js", () => ({
  openHostedRunRelay: boundary.relay,
  serveHostedRunRelay: vi.fn(),
}));
const profile = {
  version: 1 as const,
  files: [
    {
      path: ".gemini/antigravity-acp/settings.json",
      data: JSON.stringify({ auth: { type: "oauth-personal" } }),
    },
    {
      path: ".gemini/antigravity-acp/acp_token.json",
      data: JSON.stringify({
        refresh_token: "fixture-refresh",
        client_id: "fixture-client",
        client_secret: "fixture-secret",
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    },
  ],
};
function fixture() {
  const findFirst = vi.fn().mockResolvedValue({ id: "fixture-connection" });
  const deps = {
    prisma: { userModelCredential: { findFirst } } as unknown as PrismaClient,
    sandbox: {} as SandboxProvider,
  };
  const assignedComputer = vi.fn();
  const scope = {
    context: { userId: "fixture-user", spaceId: "fixture-space" },
    signal: new AbortController().signal,
    request: {
      runId: "fixture-run",
      openModelProcess: assignedComputer,
    } as unknown as AgentRunRequest,
  };
  const config: AgentRunModel = {
    provider: "google-antigravity",
    id: "fixture-model",
    connectionId: "fixture-connection",
    nativeAuth: { provider: "google-antigravity", profile, persist: vi.fn() },
  };
  return {
    findFirst,
    deps,
    assignedComputer,
    scope,
    config,
    factory: createAccountModelProvider(deps),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  boundary.open.mockResolvedValue({ close: vi.fn() });
  boundary.factory.mockReturnValue({ provider: {}, close: vi.fn() });
  boundary.relay.mockResolvedValue({ close: vi.fn() });
});
describe("native inference account isolation", () => {
  it("allocates lazily on the exact actor connection and never calls assigned bot compute", async () => {
    const f = fixture();
    f.factory(f.config, f.scope);
    expect(boundary.open).not.toHaveBeenCalled();
    await boundary.factory.mock.calls[0]![0].open({
      signal: f.scope.signal,
      tools: [],
      callTool: vi.fn(),
    });
    expect(f.findFirst).toHaveBeenCalledWith({
      where: { id: "fixture-connection", userId: "fixture-user", provider: "google-antigravity" },
      select: { id: true },
    });
    expect(boundary.open).toHaveBeenCalledWith(f.deps, {
      actor: f.scope.context,
      operationId: "fixture-run",
      operation: "model",
      signal: f.scope.signal,
    });
    expect(f.assignedComputer).not.toHaveBeenCalled();
  });
  it("does not allocate for unsupported providers", () => {
    const f = fixture();
    expect(f.factory({ ...f.config, provider: "other" }, f.scope)).toBeUndefined();
    expect(boundary.factory).not.toHaveBeenCalled();
  });
  it("rejects missing actor or connection instead of falling back to the bot host", () => {
    const f = fixture();
    expect(() => f.factory(f.config, { ...f.scope, context: {} })).toThrow("authorized account");
    expect(() => f.factory({ ...f.config, connectionId: undefined }, f.scope)).toThrow(
      "authorized account",
    );
    expect(f.assignedComputer).not.toHaveBeenCalled();
  });
  it("does not allocate after the connection was disconnected", async () => {
    const f = fixture();
    f.findFirst.mockResolvedValue(null);
    f.factory(f.config, f.scope);
    await expect(
      boundary.factory.mock.calls[0]![0].open({
        signal: f.scope.signal,
        tools: [],
        callTool: vi.fn(),
      }),
    ).rejects.toThrow("unavailable");
    expect(boundary.open).not.toHaveBeenCalled();
  });
  it("allocates independently for repeated helper/fallback provider opens", async () => {
    const f = fixture();
    f.factory(f.config, f.scope);
    f.factory(f.config, f.scope);
    for (const call of boundary.factory.mock.calls)
      await call[0].open({ signal: f.scope.signal, tools: [], callTool: vi.fn() });
    expect(boundary.open).toHaveBeenCalledTimes(2);
    expect(f.assignedComputer).not.toHaveBeenCalled();
  });
  it("passes the selected thinking level to the isolated ACP helper", async () => {
    const f = fixture();
    f.factory({ ...f.config, thinkingLevel: "high" }, f.scope);
    await boundary.factory.mock.calls[0]![0].open({
      signal: f.scope.signal,
      tools: [],
      callTool: vi.fn(),
    });
    expect(boundary.relay.mock.calls[0]![3]).toMatchObject({ thinkingLevel: "high" });
  });
});
