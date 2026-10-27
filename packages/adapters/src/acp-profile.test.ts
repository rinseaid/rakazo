import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { AcpProfileFiles } from "./acp-profile.js";
import { persistAcpProfile, restoreAcpProfile } from "./acp-profile.js";

const paths = ["provider/account.json"];
const fixture = JSON.stringify({
  version: 1,
  files: [{ path: paths[0], data: "fake-profile-fixture" }],
});
function files(): AcpProfileFiles {
  return {
    writePrivate: vi.fn(async () => {}),
    readPrivate: vi.fn(async () => Buffer.from("fake-profile-fixture")),
    dispose: vi.fn(async () => {}),
  };
}
const context: AdapterContext = {
  spaceId: "test-space",
  userId: "test-user",
  operationId: "test",
  traceId: "trace",
  signal: new AbortController().signal,
};
describe("encrypted ACP account profiles", () => {
  it("restores only the explicitly scoped account via the existing secret store", async () => {
    const storage = files();
    const store = { load: vi.fn(async () => fixture) };
    await restoreAcpProfile({
      store,
      files: storage,
      secretRef: "opaque-ref",
      recordId: "connection-1",
      allowedPaths: paths,
    });
    expect(store.load).toHaveBeenCalledWith("opaque-ref", {
      recordId: "connection-1",
      signal: undefined,
    });
    expect(storage.writePrivate).toHaveBeenCalledWith(
      paths[0],
      Buffer.from("fake-profile-fixture"),
    );
  });
  it("rejects unexpected paths before writing any file", async () => {
    const storage = files();
    const data = JSON.stringify({
      version: 1,
      files: [
        { path: paths[0], data: "ok" },
        { path: "../other-account", data: "bad" },
      ],
    });
    await expect(
      restoreAcpProfile({
        store: { load: async () => data },
        files: storage,
        secretRef: "ref",
        recordId: "id",
        allowedPaths: paths,
      }),
    ).rejects.toThrow("could not be restored");
    expect(storage.writePrivate).not.toHaveBeenCalled();
    expect(storage.dispose).toHaveBeenCalled();
  });
  it("preserves the previous secret when compare-and-swap fails", async () => {
    const storage = files();
    const store = {
      put: vi.fn(async () => ({ id: "new", ref: "new-ref", ciphertext: "encrypted-fixture" })),
      delete: vi.fn(async () => {}),
    };
    const commit = vi.fn(async () => false);
    await expect(
      persistAcpProfile({
        store,
        files: storage,
        context,
        recordId: "id",
        allowedPaths: paths,
        requiredPaths: paths,
        previousRef: "old-ref",
        commit,
      }),
    ).rejects.toThrow("could not be saved");
    expect(commit).toHaveBeenCalledWith("new-ref", "old-ref");
    expect(store.delete).toHaveBeenCalledExactlyOnceWith("new-ref", "id");
    expect(storage.dispose).toHaveBeenCalled();
  });
  it("encrypts native state without inventing an OAuth credential", async () => {
    const storage = files();
    const store = {
      put: vi.fn(async () => ({ id: "new", ref: "new-ref", ciphertext: "encrypted" })),
      delete: vi.fn(async () => {}),
    };
    await persistAcpProfile({
      store,
      files: storage,
      context,
      recordId: "id",
      allowedPaths: paths,
      requiredPaths: paths,
      commit: async () => true,
    });
    expect(store.put).toHaveBeenCalledWith(fixture, context, { recordId: "id" });
    expect(store.delete).not.toHaveBeenCalled();
    expect(storage.dispose).toHaveBeenCalledTimes(1);
  });
  it("does not overwrite good credentials after an empty native refresh", async () => {
    const storage = files();
    vi.mocked(storage.readPrivate).mockResolvedValue(undefined);
    const store = { put: vi.fn(), delete: vi.fn() };
    await expect(
      persistAcpProfile({
        store,
        files: storage,
        context,
        recordId: "id",
        allowedPaths: paths,
        requiredPaths: paths,
        commit: async () => true,
      }),
    ).rejects.toThrow();
    expect(store.put).not.toHaveBeenCalled();
    expect(storage.dispose).toHaveBeenCalled();
  });
  it("preserves new encrypted state when commit outcome is uncertain", async () => {
    const storage = files();
    const store = {
      put: vi.fn(async () => ({ id: "new", ref: "new-ref", ciphertext: "encrypted" })),
      delete: vi.fn(async () => {}),
    };
    await expect(
      persistAcpProfile({
        store,
        files: storage,
        context,
        recordId: "id",
        allowedPaths: paths,
        requiredPaths: paths,
        previousRef: "old-ref",
        commit: async () => {
          throw new Error("database response lost");
        },
      }),
    ).rejects.toThrow("could not be saved");
    expect(store.delete).not.toHaveBeenCalled();
    expect(storage.dispose).toHaveBeenCalled();
  });
});
