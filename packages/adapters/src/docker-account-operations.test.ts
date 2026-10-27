import { afterEach, describe, expect, it, vi } from "vitest";
import { dockerAccountOperations } from "./docker-account-operations.js";

const lease = {
  id: "94c60586-cd4d-4309-ae5a-df606ad7ee1b",
  userId: "fixture-user",
  spaceId: "fixture-space",
  operationId: "fixture-operation",
  expiresAt: new Date("2030-01-01T00:00:00.000Z"),
};
const provider = () =>
  dockerAccountOperations("https://supervisor.example.test", "synthetic-supervisor-token");
afterEach(() => vi.unstubAllGlobals());

describe("Docker account operation transport", () => {
  it.each([undefined, `sha256:${"a".repeat(64)}`])(
    "captures an authenticated actual image identity without serializing it: %s",
    async (imageId) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          const reader = init.body.getReader();
          await reader.read();
          void (async () => {
            while (!(await reader.read()).done) {}
          })().catch(() => {});
          return new Response('{"type":"exit","code":0}\n', {
            headers: imageId ? { "x-rakazo-account-image-id": imageId } : {},
          });
        }),
      );
      const process = await provider().openProcess(lease, new AbortController().signal);
      expect(process.runtimeIdentity).toBe(imageId ? `docker-image:${imageId}` : undefined);
      expect(Object.keys(process)).not.toContain("runtimeIdentity");
      expect(Object.getOwnPropertyDescriptor(process, "runtimeIdentity")).toMatchObject({
        writable: false,
        configurable: false,
      });
      await process.exited;
      await process.close();
    },
  );
  it.each(["fixture:mutable-tag", "sha256:invalid", ""])(
    "rejects malformed image attestation without reflecting it: %s",
    async (imageId) => {
      const cancelled = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          const reader = init.body.getReader();
          await reader.read();
          void (async () => {
            while (!(await reader.read()).done) {}
          })().catch(() => {});
          return new Response(new ReadableStream({ cancel: cancelled }), {
            headers: { "x-rakazo-account-image-id": imageId },
          });
        }),
      );
      await expect(provider().openProcess(lease, new AbortController().signal)).rejects.toThrow(
        "Invalid private host runtime identity",
      );
      expect(cancelled).toHaveBeenCalledTimes(1);
    },
  );
  it("requires explicit qualified capability and bounds operations", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          Response.json({ supported: true, operations: ["model-login", "shell", "model-catalog"] }),
        ),
    );
    expect(await provider().capabilities(new AbortController().signal)).toEqual([
      "model-login",
      "model-catalog",
    ]);
  });
  it("fails closed on older supervisors and unqualified images", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ supported: false, operations: ["model-login"] }));
    vi.stubGlobal("fetch", fetch);
    expect(await provider().capabilities(new AbortController().signal)).toEqual([]);
    expect(await provider().capabilities(new AbortController().signal)).toEqual([]);
  });
  it("uses separate actor-fenced namespace with no bot identity, profile, home or command", async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: "ignored" }));
    vi.stubGlobal("fetch", fetch);
    await provider().provision(lease, "model-login", new AbortController().signal);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://supervisor.example.test/account-hosts");
    expect(request.headers).toMatchObject({
      "x-rakazo-user-id": lease.userId,
      "x-rakazo-space-id": lease.spaceId,
      "x-rakazo-operation-id": lease.operationId,
      "x-rakazo-lease-id": lease.id,
    });
    expect(request.headers).not.toHaveProperty("x-rakazo-bot-id");
    expect(JSON.parse(request.body)).toEqual({
      userId: lease.userId,
      spaceId: lease.spaceId,
      operationId: lease.operationId,
      leaseId: lease.id,
      expiresAt: lease.expiresAt.toISOString(),
      operation: "model-login",
    });
  });
  it("does not confuse an unsupported DELETE route with confirmed absence", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    await expect(provider().destroy(lease, new AbortController().signal)).rejects.toThrow(
      "unavailable",
    );
  });
  it("rejects path-shaped lease IDs before any request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      provider().destroy({ ...lease, id: "../computer" }, new AbortController().signal),
    ).rejects.toThrow("Invalid account host lease");
    expect(fetch).not.toHaveBeenCalled();
  });
});
