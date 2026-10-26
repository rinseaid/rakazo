import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getCustomUsage,
  parseCustomUsage,
  readCustomUsage,
  setCustomUsage,
} from "./custom-usage.js";

const mock = vi.hoisted(() => ({ validate: vi.fn(), request: vi.fn(), close: vi.fn() }));
vi.mock("@rakazo/adapters", () => ({
  assertSafeRemoteUrl: mock.validate,
  createSafeRemoteFetch: () => Object.assign(mock.request, { close: mock.close }),
}));
vi.mock("./mcp-servers.js", () => ({ mayUsePrivateEndpoint: () => false }));

const actor = {
  userId: "user",
  spaceId: "space",
  email: "test@example.test",
  isDeploymentOwner: false,
};
const original = {
  id: "credential",
  userId: "user",
  customUsageSecretId: "secret",
  customUsageCiphertext: JSON.stringify({
    endpoint: "https://usage.example.test/",
    token: "independent-token",
  }),
};
let row: typeof original;
const ctx = {
  deps: {
    prisma: { userModelCredential: { findFirst: vi.fn(), updateMany: vi.fn() } },
    secrets: { load: vi.fn(), put: vi.fn() },
    remoteConnectors: undefined,
    env: {},
  },
} as never;
const deps = (ctx as any).deps;

beforeEach(() => {
  vi.clearAllMocks();
  row = { ...original };
  deps.prisma.userModelCredential.findFirst.mockImplementation(async ({ where }: any) =>
    where.userId === actor.userId ? row : null,
  );
  deps.prisma.userModelCredential.updateMany.mockImplementation(async ({ data }: any) => {
    Object.assign(row, data);
    return { count: 1 };
  });
  deps.secrets.load.mockImplementation(async (ciphertext: string) => ciphertext);
  deps.secrets.put.mockImplementation(async (value: string) => ({
    id: "new-secret",
    ciphertext: value,
  }));
  mock.validate.mockImplementation(async (value: string) => new URL(value));
  mock.close.mockResolvedValue(undefined);
});

describe("custom usage", () => {
  it("validates windows and rejects malformed or duplicated values", () => {
    expect(parseCustomUsage({ windows: [{ id: "daily", usedPercent: 40 }] })).toEqual([
      { id: "daily", usedPercent: 40, resetsAt: null, modelIds: null },
    ]);
    expect(() => parseCustomUsage({ windows: [{ id: "x", usedPercent: 101 }] })).toThrow();
    expect(() =>
      parseCustomUsage({
        windows: [
          { id: "x", usedPercent: 0 },
          { id: "x", usedPercent: 1 },
        ],
      }),
    ).toThrow();
  });
  it("keeps the token secret and does not send it to a changed endpoint", async () => {
    expect(await getCustomUsage(ctx, actor, "credential")).toEqual({
      endpoint: "https://usage.example.test/",
      hasToken: true,
    });
    await setCustomUsage(ctx, actor, {
      credentialId: "credential",
      endpoint: "https://other.example.test/",
    });
    expect(JSON.parse(row.customUsageCiphertext).token).toBeNull();
    expect(deps.secrets.put.mock.calls[0][2]).toEqual({ ephemeral: true });
    expect(await getCustomUsage(ctx, actor, "credential")).toEqual({
      endpoint: "https://other.example.test/",
      hasToken: false,
    });
  });
  it("preserves an unchanged endpoint token, and clears it when explicitly removed", async () => {
    await setCustomUsage(ctx, actor, {
      credentialId: "credential",
      endpoint: "https://usage.example.test/",
    });
    expect(JSON.parse(row.customUsageCiphertext).token).toBe("independent-token");
    await setCustomUsage(ctx, actor, {
      credentialId: "credential",
      endpoint: "https://usage.example.test/",
      token: "",
    });
    expect(JSON.parse(row.customUsageCiphertext).token).toBeNull();
    await setCustomUsage(ctx, actor, { credentialId: "credential", endpoint: null });
    expect(row.customUsageCiphertext).toBeNull();
  });
  it("does not reuse the model credential and refuses an unsafe endpoint", async () => {
    mock.validate.mockRejectedValueOnce(new Error("blocked"));
    await expect(
      setCustomUsage(ctx, actor, {
        credentialId: "credential",
        endpoint: "http://169.254.169.254/",
      }),
    ).rejects.toThrow();
    expect(deps.secrets.put).not.toHaveBeenCalled();
    await expect(
      setCustomUsage(ctx, actor, {
        credentialId: "credential",
        endpoint: "http://example.test/",
        token: "token",
      }),
    ).rejects.toThrow();
  });
  it("reads only the custom bearer token and never creates an admission pool", async () => {
    mock.request.mockResolvedValue(
      new Response(
        JSON.stringify({
          windows: [{ id: "weekly", usedPercent: 25, resetsAt: "2030-01-01T00:00:00.000Z" }],
        }),
        { status: 200 },
      ),
    );
    const result = await readCustomUsage(ctx, row as never);
    expect(result.view.status).toBe("fresh");
    expect(result.view.windows[0]?.usedPercent).toBe(25);
    expect(result.poolKey).toBeNull();
    expect(mock.request.mock.calls[0][0]).toBe("https://usage.example.test/");
    expect(mock.request.mock.calls[0][1].headers.authorization).toBe("Bearer independent-token");
    expect(mock.close).toHaveBeenCalled();
  });
  it("reports invalid data and oversized responses as unavailable", async () => {
    mock.request
      .mockResolvedValueOnce(new Response(JSON.stringify({ windows: [] })))
      .mockResolvedValueOnce(new Response("x".repeat(65_537)));
    expect((await readCustomUsage(ctx, row as never)).view.status).toBe("unavailable");
    expect((await readCustomUsage(ctx, row as never)).view.status).toBe("unavailable");
  });
  it("refuses accounts belonging to another user", async () => {
    await expect(
      getCustomUsage(ctx, { ...actor, userId: "other" }, "credential"),
    ).rejects.toThrow();
  });
});
