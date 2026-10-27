import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NativeModelLoginRunner, PiOAuthConnected, PiOAuthHandoffStore } from "./pi-oauth.js";
import { PiOAuthLogins, SUBSCRIPTION_SIGN_IN_PROVIDERS } from "./pi-oauth.js";

const actor = { userId: "user", spaceId: "space" };
const provider = "google-antigravity";
const nativeSecret = {
  kind: "native" as const,
  provider,
  profile: {
    version: 1 as const,
    files: [{ path: "account/auth.json", data: '{"token":"fake-native-token"}' }],
  },
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function controlled(handoff?: PiOAuthHandoffStore) {
  const requests: Array<Parameters<NativeModelLoginRunner>[0]> = [];
  const resolvers: Array<(value: typeof nativeSecret) => void> = [];
  const native = vi.fn<NativeModelLoginRunner>(async (input) => {
    requests.push(input);
    input.interaction.notify({
      type: "auth_url",
      url: "https://accounts.example.invalid/auth",
      instructions: "Open",
    });
    return new Promise((resolve) => resolvers.push(resolve));
  });
  const oauth = vi.fn();
  const logins = new PiOAuthLogins(oauth, handoff, native);
  return {
    logins,
    requests,
    resolvers,
    native,
    oauth,
    begin: () =>
      logins.begin({ ...actor, provider, credentialId: "connection", deferModelSelection: true }),
  };
}

describe("model-managed native sign-in lifecycle", () => {
  beforeEach(() => vi.stubEnv("RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED", "true"));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
  it("is disabled without an injected runner and does not globally advertise sign-in", async () => {
    expect(SUBSCRIPTION_SIGN_IN_PROVIDERS[provider]).toBeUndefined();
    vi.stubEnv("RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED", "false");
    await expect(
      new PiOAuthLogins().begin({ ...actor, provider, deferModelSelection: true }),
    ).rejects.toThrow(/not enabled on this server/);
    vi.stubEnv("RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED", "true");
    await expect(
      new PiOAuthLogins().begin({ ...actor, provider, deferModelSelection: true }),
    ).rejects.toThrow(/only available/);
  });
  it("uses the shared manual callback-URL interaction without minting an OAuth token", async () => {
    const native = vi.fn<NativeModelLoginRunner>(async ({ interaction }) => {
      interaction.notify({
        type: "auth_url",
        url: "https://accounts.example.invalid/auth",
        instructions: "Open",
      });
      const callback = await interaction.prompt({
        type: "manual_code",
        message: "Paste callback URL",
      });
      expect(callback).toBe("http://localhost:1234/callback?code=fake-code&state=fake-state");
      return nativeSecret;
    });
    const oauth = vi.fn();
    const logins = new PiOAuthLogins(oauth, undefined, native);
    const started = await logins.begin({
      ...actor,
      provider,
      credentialId: "connection",
      deferModelSelection: true,
    });
    expect(started.mode).toBe("auth-url");
    expect(native).toHaveBeenCalledWith(
      expect.objectContaining({
        actor,
        loginId: started.loginId,
        provider,
        credentialId: "connection",
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(
      logins.submit(started.loginId, { ...actor, userId: "other" }, "fake-code"),
    ).rejects.toThrow(/not found/);
    await logins.submit(
      started.loginId,
      actor,
      "http://localhost:1234/callback?code=fake-code&state=fake-state",
    );
    await flush();
    expect(logins.complete(started.loginId, actor)).toMatchObject({
      status: "connected",
      authKind: "native",
      nativeSecret,
    });
    const persist = vi.fn(async (result: PiOAuthConnected) => {
      expect(result.credential).toBeUndefined();
      return "saved";
    });
    expect(await logins.finish(started.loginId, actor, persist)).toEqual({
      status: "connected",
      value: "saved",
    });
    expect(persist).toHaveBeenCalledOnce();
    expect(oauth).not.toHaveBeenCalled();
    expect((await logins.finish(started.loginId, actor, persist)).status).toBe("error");
  });
  it.each(["cancel", "replace", "disconnect", "shutdown", "expire"])(
    "cannot persist late native results after %s",
    async (action) => {
      vi.useFakeTimers();
      const f = controlled();
      const started = await f.begin();
      if (action === "cancel") await f.logins.cancel(started.loginId, actor);
      if (action === "replace") await f.begin();
      if (action === "disconnect")
        await f.logins.cancelProvider({ ...actor, provider, credentialId: "connection" });
      if (action === "shutdown") f.logins.abortAll();
      if (action === "expire") await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
      expect(f.requests[0]?.signal.aborted).toBe(true);
      f.resolvers[0]!(nativeSecret);
      await flush();
      const persist = vi.fn();
      expect((await f.logins.finish(started.loginId, actor, persist)).status).toBe("error");
      expect(persist).not.toHaveBeenCalled();
      f.logins.abortAll();
    },
  );
  it("serializes finalization before cancellation or replacement", async () => {
    const f = controlled();
    const started = await f.begin();
    f.resolvers[0]!(nativeSecret);
    await flush();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const finishing = f.logins.finish(started.loginId, actor, async () => {
      await gate;
      return "saved";
    });
    let replaced = false;
    const replacement = f.begin().then(() => {
      replaced = true;
    });
    await flush();
    expect(replaced).toBe(false);
    expect(f.requests[0]?.signal.aborted).toBe(false);
    release();
    expect(await finishing).toEqual({ status: "connected", value: "saved" });
    await replacement;
    expect(replaced).toBe(true);
    f.logins.abortAll();
  });
  it("does not hand native process state to another API process as an OAuth verifier", async () => {
    const create = vi.fn();
    const handoff = {
      prisma: { modelOAuthSession: { create } },
      secrets: { put: vi.fn() },
    } as unknown as PiOAuthHandoffStore;
    const f = controlled(handoff);
    const started = await f.begin();
    expect(handoff.secrets.put).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    f.resolvers[0]!(nativeSecret);
    await flush();
    expect(f.logins.complete(started.loginId, actor)).toMatchObject({ authKind: "native" });
    f.logins.abortAll();
  });
  it("refuses a stored native verifier handoff rather than restarting its hosted process", async () => {
    const handoff = {
      prisma: {
        modelOAuthSession: {
          findFirst: vi.fn(async () => ({ ciphertext: "encrypted-handoff" })),
          deleteMany: vi.fn(async () => ({ count: 1 })),
        },
      },
      secrets: {
        put: vi.fn(),
        load: vi.fn(async () => JSON.stringify({ provider, verifier: "fake-verifier" })),
      },
    } as unknown as PiOAuthHandoffStore;
    const f = controlled(handoff);
    await expect(f.logins.submit("old-native-login", actor, "fake-callback")).rejects.toThrow(
      /not found/,
    );
    expect(f.native).not.toHaveBeenCalled();
    expect(f.oauth).not.toHaveBeenCalled();
  });
  it("rejects malformed or wrong-provider runner output and does not expose runner secrets", async () => {
    const f = controlled();
    const started = await f.begin();
    f.resolvers[0]!({ ...nativeSecret, provider: "anthropic" });
    await flush();
    expect(f.logins.complete(started.loginId, actor)).toEqual({
      status: "error",
      error: "Native account sign-in failed. Try again.",
    });
    const logins = new PiOAuthLogins(undefined, undefined, async () => {
      throw new Error("fake-sensitive-callback");
    });
    await expect(logins.begin({ ...actor, provider, deferModelSelection: true })).rejects.toThrow(
      "Native account sign-in failed. Try again.",
    );
  });
});
