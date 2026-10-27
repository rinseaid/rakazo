import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createHostedNativeCatalog,
  createHostedNativeLogin,
  discoverHostedNativeModels,
} from "./hosted-native-account.js";
import { serializeModelSecret } from "./pi-oauth.js";

const boundary = vi.hoisted(() => ({
  host: vi.fn(),
  relay: vi.fn(),
  native: vi.fn(),
  loggerInfo: vi.fn(),
}));
vi.mock("@rakazo/logging", () => ({ getLogger: () => ({ info: boundary.loggerInfo }) }));
vi.mock("./account-operation-host.js", () => ({ withAccountOperationHost: boundary.host }));
vi.mock("./native-account-relay.js", () => ({ runNativeAccountOperation: boundary.relay }));
vi.mock("./model-native-credential.js", () => ({ nativeModelAuth: boundary.native }));
const actor = { userId: "fixture-user", spaceId: "fixture-space" };
const profile = {
  version: 1 as const,
  files: [{ path: "account.json", data: '{"token":"fixture-token"}' }],
};
const signal = () => new AbortController().signal;
function fixture() {
  const connection = {
    findFirst: vi.fn().mockResolvedValue({ id: "fixture-connection", secretId: "fixture-secret" }),
  };
  const secret = {
    findFirst: vi
      .fn()
      .mockResolvedValue({ id: "fixture-secret", ciphertext: "fixture-ciphertext" }),
  };
  const load = vi
    .fn()
    .mockResolvedValue(
      serializeModelSecret({ kind: "native", provider: "google-antigravity", profile }),
    );
  const deps = {
    prisma: { userModelCredential: connection, secret } as unknown as PrismaClient,
    sandbox: {},
    secretStore: { load } as unknown as SecretStore,
  };
  const persist = vi.fn().mockResolvedValue(true);
  boundary.native.mockReturnValue({ provider: "google-antigravity", profile, persist });
  return {
    deps: deps as Parameters<typeof createHostedNativeCatalog>[0],
    connection,
    secret,
    load,
    persist,
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  boundary.host.mockImplementation(async (_deps, input, run) => run({}, input.signal));
});
describe("hosted native account composition", () => {
  it("uses shared native login identity and interaction without starting a local process", async () => {
    const f = fixture();
    const secret = { kind: "native", provider: "google-antigravity", profile };
    const diagnostic = {
      stage: "acp_initialize_complete" as const,
      durationMs: 23,
      protocolVersion: 1 as const,
      authMethodAvailable: true,
    };
    boundary.relay.mockImplementationOnce(
      async (_process, _operation, _interaction, _signal, onDiagnostic) => {
        onDiagnostic?.(diagnostic);
        return { kind: "login", secret };
      },
    );
    const interaction = { notify: vi.fn(), prompt: vi.fn() };
    const input = {
      actor,
      provider: "google-antigravity",
      loginId: "fixture-login",
      signal: signal(),
      interaction,
    };
    expect(await createHostedNativeLogin(f.deps)(input)).toEqual(secret);
    expect(Object.keys(boundary.host.mock.calls[0]![1]).sort()).toEqual([
      "actor",
      "onDiagnostic",
      "operation",
      "operationId",
      "signal",
    ]);
    expect(boundary.host.mock.calls[0]![1]).toMatchObject({
      actor,
      operationId: "fixture-login",
      operation: "model-login",
    });
    expect(boundary.relay).toHaveBeenCalledWith(
      {},
      { kind: "login", provider: input.provider, loginId: input.loginId, actor },
      interaction,
      input.signal,
      expect.any(Function),
    );
    expect(boundary.loggerInfo).toHaveBeenCalledWith("native_account_login.stage", diagnostic);
  });
  it("reads only the exact caller-owned connection and persists through its existing fence", async () => {
    const f = fixture();
    const catalog = createHostedNativeCatalog(f.deps);
    boundary.relay.mockResolvedValue({
      kind: "catalog",
      profile,
      discovery: {
        models: [{ id: "fixture-model", name: "Fixture", thinkingLevels: ["low", "high"] }],
      },
    });
    const result = await catalog({
      actor,
      provider: "google-antigravity",
      credentialId: "fixture-connection",
      signal: signal(),
    });
    expect(result.models).toEqual(["fixture-model"]);
    expect(result.thinkingLevelsByModel).toEqual({ "fixture-model": ["low", "high"] });
    expect(result.generation).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(f.connection.findFirst).toHaveBeenCalledWith({
      where: { id: "fixture-connection", userId: actor.userId, provider: "google-antigravity" },
      select: { id: true, secretId: true },
    });
    expect(f.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "fixture-secret", userId: actor.userId, spaceId: null },
      select: { id: true, ciphertext: true },
    });
    expect(boundary.native).toHaveBeenCalledWith(
      expect.objectContaining({
        ...actor,
        credentialId: "fixture-connection",
        secretId: "fixture-secret",
        ciphertext: "fixture-ciphertext",
      }),
    );
    expect(Object.keys(boundary.host.mock.calls[0]![1]).sort()).toEqual([
      "actor",
      "operation",
      "operationId",
      "signal",
    ]);
    expect(f.persist).toHaveBeenCalledWith(profile);
    const contains = await catalog({
      actor,
      provider: "google-antigravity",
      credentialId: "fixture-connection",
      signal: signal(),
      action: "contains",
      modelId: "fixture-model",
      profileRevision: undefined,
    });
    expect(contains).toEqual({
      models: ["fixture-model"],
      generation: result.generation,
      thinkingLevelsByModel: { "fixture-model": ["low", "high"] },
    });
    await expect(
      catalog({
        actor,
        provider: "google-antigravity",
        credentialId: "fixture-connection",
        signal: signal(),
        action: "validate",
        modelId: "other-account-model",
        generation: result.generation,
      }),
    ).rejects.toThrow(/current discovery/);
  });
  it("does not start a host for another user's or missing connection", async () => {
    const f = fixture();
    f.connection.findFirst.mockResolvedValue(null);
    await expect(
      createHostedNativeCatalog(f.deps)({
        actor,
        provider: "google-antigravity",
        credentialId: "missing",
        signal: signal(),
      }),
    ).rejects.toThrow("Connection not found");
    expect(boundary.host).not.toHaveBeenCalled();
  });
  it("rejects a stale catalog after reconnect/disconnect instead of returning old models", async () => {
    const f = fixture();
    f.persist.mockResolvedValue(false);
    boundary.relay.mockResolvedValue({ kind: "catalog", profile, discovery: { models: [] } });
    await expect(
      discoverHostedNativeModels(f.deps, {
        actor,
        operationId: "fixture-catalog",
        native: boundary.native(),
        signal: signal(),
      }),
    ).rejects.toThrow("Native account changed");
  });
  it("never persists an account if the isolated host did not finish cleanup", async () => {
    const f = fixture();
    boundary.host.mockRejectedValue(new Error("cleanup incomplete"));
    await expect(
      discoverHostedNativeModels(f.deps, {
        actor,
        operationId: "fixture-catalog",
        native: boundary.native(),
        signal: signal(),
      }),
    ).rejects.toThrow("cleanup incomplete");
    expect(f.persist).not.toHaveBeenCalled();
  });
});
