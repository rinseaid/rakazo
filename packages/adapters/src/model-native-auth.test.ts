import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext, modelCredentialDto } from "./model-connect.js";
import {
  GOOGLE_ANTIGRAVITY_PLACEHOLDER_MODEL_ID,
  nativeModelProviderEnabled,
  parseNativeModelProfile,
} from "./model-native-auth.js";
import { validateModelAuthAvailability } from "./model-selection.js";
import {
  parseModelSecret,
  resolveModelApiKey,
  resolveModelAuth,
  serializeModelSecret,
} from "./pi-oauth.js";

const profile = {
  version: 1 as const,
  files: [{ path: "account/auth.json", data: '{"refresh":"fake-refresh"}' }],
};
const native = { kind: "native" as const, provider: "google-antigravity", profile };

afterEach(() => vi.unstubAllEnvs());

describe("model-managed account profiles", () => {
  it("keeps native Google disabled by default and rejects its UI-only placeholder as a model", () => {
    expect(nativeModelProviderEnabled("google-antigravity", {})).toBe(false);
    expect(
      nativeModelProviderEnabled("google-antigravity", {
        RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED: "false",
      }),
    ).toBe(false);
    expect(
      nativeModelProviderEnabled("google-antigravity", {
        RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED: "true",
      }),
    ).toBe(true);
    expect(
      nativeModelProviderEnabled("anthropic", { RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED: "true" }),
    ).toBe(false);
    expect(
      validateModelAuthAvailability(
        "google-antigravity",
        GOOGLE_ANTIGRAVITY_PLACEHOLDER_MODEL_ID,
        JSON.stringify(native),
      ),
    ).toMatch(/not available/);
  });
  it.each([
    JSON.stringify(native),
    JSON.stringify(profile),
    JSON.stringify({
      ...native,
      profile: { version: 1, files: [{ path: "auth", data: "x".repeat(128 * 1024) }] },
    }),
    JSON.stringify({
      kind: "oauth",
      credential: { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 1 },
    }),
  ])("does not import raw credential JSON through an API-key input %#", (apiKey) => {
    expect(() => buildModelConnectPlaintext({ provider: "openrouter", apiKey })).toThrow();
    expect(() =>
      buildModelConnectPlaintext({
        provider: "openai-compatible",
        baseUrl: "https://example.invalid/v1",
        modelId: "fake-model",
        apiKey,
      }),
    ).toThrow();
  });
  it("round-trips the encrypted envelope without an invented API key or OAuth credential", async () => {
    vi.stubEnv("RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED", "true");
    const plaintext = serializeModelSecret(native);
    expect(parseModelSecret(plaintext)).toEqual(native);
    expect(await resolveModelAuth(plaintext, native.provider)).toEqual({ secret: native });
    await expect(resolveModelApiKey(plaintext, native.provider)).rejects.toThrow(
      /cannot be used as API keys/,
    );
    await expect(resolveModelAuth(plaintext, "anthropic")).rejects.toThrow(/does not match/);
    expect(validateModelAuthAvailability("anthropic", "unused", plaintext)).toMatch(
      /not available/,
    );
    expect(
      modelCredentialDto(
        { id: "connection", provider: native.provider, label: "Account" },
        plaintext,
      ),
    ).toMatchObject({ hasKey: false, authKind: "native" });
  });

  it.each([
    {},
    { version: 2, files: profile.files },
    { version: 1, files: [] },
    { version: 1, files: [...profile.files, ...profile.files] },
    ...["/absolute", "../escape", "a/../b", "a//b", "a\\b", "a\0b", "a/./b", "a:"].map((path) => ({
      version: 1,
      files: [{ path, data: "fake" }],
    })),
    { version: 1, files: [{ path: "auth", data: "" }] },
    { version: 1, files: [{ path: "auth", data: "x".repeat(128 * 1024) }] },
    {
      version: 1,
      files: Array.from({ length: 17 }, (_, i) => ({ path: `file-${i}`, data: "fake" })),
    },
  ])("rejects malformed, unsafe or oversized native profile %#", (invalid) => {
    expect(() => parseNativeModelProfile(invalid)).toThrow();
    expect(() => parseModelSecret(JSON.stringify({ ...native, profile: invalid }))).toThrow();
  });

  it.each([
    '{"kind":"native",',
    JSON.stringify({ kind: "native" }),
    JSON.stringify({ ...native, provider: "" }),
    JSON.stringify({ ...native, provider: "UPPER" }),
  ])("never interprets malformed native state as a legacy API key %#", async (invalid) => {
    expect(() => parseModelSecret(invalid)).toThrow();
    await expect(resolveModelApiKey(invalid, native.provider)).rejects.toThrow();
    expect(() =>
      buildModelConnectPlaintext(
        { provider: native.provider, apiKey: "fake-key-replacement" },
        invalid,
      ),
    ).toThrow();
  });

  it("preserves native state during settings edits and refuses key substitution", () => {
    const plaintext = serializeModelSecret({ ...native, maxTokens: 4096 });
    expect(
      parseModelSecret(
        buildModelConnectPlaintext({ provider: native.provider, maxTokens: 8192 }, plaintext),
      ),
    ).toEqual({ ...native, maxTokens: 8192 });
    expect(() =>
      buildModelConnectPlaintext({ provider: native.provider, apiKey: "fake-key" }, plaintext),
    ).toThrow(/require sign-in/);
    expect(() => buildModelConnectPlaintext({ provider: "anthropic" }, plaintext)).toThrow(
      /does not match/,
    );
  });
});
