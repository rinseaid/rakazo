import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRunExecutor } from "./executor.js";
import type * as PiModels from "./pi-models.js";
import { serializeModelSecret } from "./pi-oauth.js";

vi.mock("./pi-models.js", async (original) => {
  const module = await original<typeof PiModels>();
  return {
    ...module,
    listPiCatalog: () => [
      ...module.listPiCatalog(),
      { provider: "google-antigravity", id: "fake-native-model" },
    ],
  };
});
const provider = "google-antigravity";
const scope = { userId: "user", spaceId: "space" };
const profile = {
  version: 1 as const,
  files: [{ path: "account/auth.json", data: '{"token":"fake-token"}' }],
};
function fixture(plaintext = serializeModelSecret({ kind: "native", provider, profile })) {
  const credential = {
    id: "connection",
    userId: "user",
    provider,
    secretId: "secret",
    label: "Account",
    userPreferences: [],
  };
  const prisma = {
    userModelCredential: { findFirst: vi.fn(async () => credential) },
    secret: {
      findFirst: vi.fn(async () => ({
        id: "secret",
        userId: "user",
        spaceId: null,
        ciphertext: "encrypted",
      })),
    },
  };
  const load = vi.fn(async () => plaintext);
  const executor = createRunExecutor({
    billingEnabled: false,
    prisma,
    secretStore: { load, put: vi.fn() },
  } as unknown as Parameters<typeof createRunExecutor>[0]);
  const resolve = () =>
    executor.resolveConnectedModel(
      scope,
      provider,
      "fake-native-model",
      undefined,
      false,
      undefined,
      "connection",
    );
  return { resolve, prisma, load };
}

describe("native connection runtime authorization", () => {
  beforeEach(() => vi.stubEnv("RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED", "true"));
  afterEach(() => vi.unstubAllEnvs());
  it("loads only the user-owned connection and issues a scoped native capability without a key", async () => {
    const f = fixture();
    const model = await f.resolve();
    expect(model).toMatchObject({
      provider,
      connectionId: "connection",
      nativeAuth: { provider, profile },
    });
    expect(model.apiKey).toBeUndefined();
    expect(model.oauth).toBeUndefined();
    expect(f.prisma.userModelCredential.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "connection", userId: "user", provider } }),
    );
    expect(f.prisma.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "secret", userId: "user", spaceId: null },
    });
  });
  it("never recovers missing native secrets from a deployment API key", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "fake-deployment-key");
    const f = fixture();
    f.prisma.secret.findFirst.mockResolvedValue(null as never);
    await expect(f.resolve()).rejects.toThrow(/Native account sign-in/);
    expect(f.load).not.toHaveBeenCalled();
  });
  it("resolves a saved native model without a worker-local discovery cache", async () => {
    await expect(fixture().resolve()).resolves.toMatchObject({
      nativeAuth: { provider, profile },
    });
  });
  it.each([
    "fake-api-key",
    '{"kind":"native",',
    JSON.stringify({ kind: "native", provider: "anthropic", profile }),
  ])("rejects invalid native credential %#", async (invalid) => {
    await expect(fixture(invalid).resolve()).rejects.toThrow();
  });
  it("does not issue a native capability when the connection is not owned by the caller", async () => {
    const f = fixture();
    f.prisma.userModelCredential.findFirst.mockResolvedValue(null as never);
    await expect(f.resolve()).rejects.toThrow(/Connect that model provider first/);
    expect(f.load).not.toHaveBeenCalled();
  });
});
