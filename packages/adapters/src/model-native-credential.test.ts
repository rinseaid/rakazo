import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { describe, expect, it, vi } from "vitest";
import { InfisicalSecretStore } from "./infisical-secret-store.js";
import { nativeModelAuth } from "./model-native-credential.js";
import { infisicalFake } from "./secret-store-fake.js";
import { EncryptedSecretStore } from "./secrets.js";

const profile = {
  version: 1 as const,
  files: [{ path: "account/auth.json", data: '{"token":"fake-original"}' }],
};
function fixture(store?: Pick<SecretStore, "put" | "delete">) {
  const state = {
    connected: true,
    ciphertext: "encrypted-original",
    secretId: "secret",
    owner: "user",
  };
  const secret = {
    updateMany: vi.fn(async ({ where, data }) => {
      if (state.ciphertext !== where.ciphertext || state.owner !== where.userId)
        return { count: 0 };
      state.ciphertext = data.ciphertext;
      return { count: 1 };
    }),
  };
  const userModelCredential = {
    updateMany: vi.fn(async ({ where }) => ({
      count:
        state.connected && state.secretId === where.secretId && state.owner === where.userId
          ? 1
          : 0,
    })),
  };
  const prisma = { $transaction: vi.fn(async (fn) => fn({ secret, userModelCredential })) };
  let counter = 0;
  const put = vi.fn(async () => ({
    ciphertext: `encrypted-${++counter}`,
    ref: `encrypted-${counter}`,
  }));
  const remove = vi.fn(async () => undefined);
  const registerSecrets = vi.fn();
  const makeAuth = () =>
    nativeModelAuth({
      prisma: prisma as unknown as Pick<PrismaClient, "$transaction">,
      secretStore:
        store ?? ({ put, delete: remove } as unknown as Pick<SecretStore, "put" | "delete">),
      userId: "user",
      spaceId: "space",
      credentialId: "connection",
      secretId: "secret",
      ciphertext: state.ciphertext,
      secret: { kind: "native", provider: "google-antigravity", profile },
      registerSecrets,
    });
  return { state, secret, userModelCredential, prisma, put, remove, registerSecrets, makeAuth };
}

describe("authorized native profile persistence", () => {
  it("does not serialize profile material into generic logs or checkpoints", () => {
    const auth = fixture().makeAuth();
    expect(auth.profile).toEqual(profile);
    expect(auth.accountGeneration).toBe("secret");
    expect(JSON.parse(JSON.stringify({ nativeAuth: auth }))).toEqual({
      nativeAuth: { provider: "google-antigravity" },
    });
  });
  it("retains the loaded account generation across refresh and reconnect", async () => {
    const f = fixture();
    const auth = f.makeAuth();
    await auth.persist(profile);
    expect(auth.accountGeneration).toBe("secret");
    f.state.secretId = "replacement-secret";
    expect(await auth.persist(profile)).toBe(false);
    expect(auth.accountGeneration).toBe("secret");
    expect(Object.keys(auth)).not.toContain("accountGeneration");
  });
  it("persists through the encrypted store and advances its compare-and-swap fence", async () => {
    const f = fixture();
    const auth = f.makeAuth();
    expect(await auth.persist(profile)).toBe(true);
    expect(await auth.persist(profile)).toBe(true);
    expect(f.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ userId: "user", spaceId: "space" }),
      { recordId: "secret" },
    );
    expect(f.secret.updateMany.mock.calls[1]?.[0].where.ciphertext).toBe("encrypted-1");
    expect(f.registerSecrets).toHaveBeenCalledWith(expect.arrayContaining(["fake-original"]));
  });
  it.each(["disconnect", "reconnect", "owner change", "concurrent refresh"])(
    "refuses a stale writer after %s",
    async (change) => {
      const f = fixture();
      const auth = f.makeAuth();
      if (change === "disconnect") f.state.connected = false;
      if (change === "reconnect") f.state.secretId = "new-secret";
      if (change === "owner change") f.state.owner = "other-user";
      if (change === "concurrent refresh") f.state.ciphertext = "encrypted-newer";
      const before = f.state.ciphertext;
      expect(await auth.persist(profile)).toBe(false);
      expect(f.state.ciphertext).toBe(before);
      if (change !== "concurrent refresh") expect(f.secret.updateMany).not.toHaveBeenCalled();
    },
  );
  it("fences two capabilities loaded from the same secret version", async () => {
    const f = fixture();
    const first = f.makeAuth();
    const second = f.makeAuth();
    expect(await first.persist(profile)).toBe(true);
    expect(await second.persist(profile)).toBe(false);
  });
  it("rejects invalid refreshed state before encryption or any database write", async () => {
    const f = fixture();
    await expect(f.makeAuth().persist({ version: 1, files: [] })).rejects.toThrow(/invalid/);
    expect(f.put).not.toHaveBeenCalled();
    expect(f.userModelCredential.updateMany).not.toHaveBeenCalled();
  });
});

describe.each(["encrypted", "Infisical"] as const)("%s native profile cleanup", (backend) => {
  const setup = async () => {
    const fake = infisicalFake();
    const store =
      backend === "encrypted"
        ? new EncryptedSecretStore("fake-test-key")
        : new InfisicalSecretStore(fake.options);
    const context = {
      operationId: "test",
      traceId: "test",
      userId: "user",
      spaceId: "space",
      signal: new AbortController().signal,
    };
    const initial = await store.put("fake-original-profile", context, { recordId: "secret" });
    const unrelated = await store.put("fake-other-account", context, { recordId: "other-secret" });
    const remove = vi.spyOn(store, "delete");
    const put = vi.spyOn(store, "put");
    const f = fixture(store);
    f.state.ciphertext = initial.ref;
    return { ...f, store, initial, unrelated, remove, put, fake };
  };
  it.each(["success", "stale", "other-account"])(
    "cleans only the obsolete own ref after definite %s",
    async (outcome) => {
      const f = await setup();
      try {
        const auth = f.makeAuth();
        if (outcome === "stale") f.state.connected = false;
        if (outcome === "other-account") {
          f.state.owner = "other-user";
          f.state.ciphertext = f.unrelated.ref;
        }
        expect(await auth.persist(profile)).toBe(outcome === "success");
        const next = await f.put.mock.results[0]!.value;
        const obsolete = outcome === "success" ? f.initial.ref : next.ref;
        expect(f.remove).toHaveBeenCalledExactlyOnceWith(obsolete, {
          recordId: "secret",
          signal: expect.any(AbortSignal),
        });
        expect(f.remove).not.toHaveBeenCalledWith(f.unrelated.ref, expect.anything());
        await expect(f.store.load(f.unrelated.ref, "other-secret")).resolves.toBe(
          "fake-other-account",
        );
        if (backend === "Infisical")
          expect(f.fake.values.has(obsolete.split(":").at(-1)!)).toBe(false);
      } finally {
        await f.store.close();
      }
    },
  );
  it.each(["before-write", "after-write"])(
    "does not delete either ref after uncertain transaction %s",
    async (when) => {
      const f = await setup();
      try {
        f.prisma.$transaction.mockImplementationOnce(async (fn) => {
          if (when === "after-write")
            await fn({ secret: f.secret, userModelCredential: f.userModelCredential });
          throw new Error("transaction outcome unknown");
        });
        await expect(f.makeAuth().persist(profile)).rejects.toThrow("transaction outcome unknown");
        expect(f.remove).not.toHaveBeenCalled();
        const next = await f.put.mock.results[0]!.value;
        await expect(f.store.load(next.ref, "secret")).resolves.toContain("fake-original");
        await expect(f.store.load(f.initial.ref, "secret")).resolves.toBe("fake-original-profile");
      } finally {
        await f.store.close();
      }
    },
  );
  it.each([true, false])(
    "preserves committed=%s outcome on cleanup failure without logging backend details",
    async (committed) => {
      const f = await setup();
      const warn = vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
      try {
        f.state.connected = committed;
        f.remove.mockRejectedValue(new Error("fake-sensitive-backend-ref"));
        expect(await f.makeAuth().persist(profile)).toBe(committed);
        expect(warn).toHaveBeenCalledExactlyOnceWith(
          "Native account profile secret cleanup did not complete",
        );
      } finally {
        warn.mockRestore();
        await f.store.close();
      }
    },
  );
});
