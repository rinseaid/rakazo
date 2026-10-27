import { beforeEach, describe, expect, it, vi } from "vitest";
import { discoverGoogleAcpCatalog } from "./google-acp-catalog.js";

const fixture = vi.hoisted(() => ({
  dispose: vi.fn(),
  request: vi.fn(),
  close: vi.fn(),
  connect: vi.fn(),
  write: vi.fn(),
  read: vi.fn(),
  createHost: vi.fn(),
}));
vi.mock("./acp-local-profile.js", () => ({
  createAcpLocalProfile: async () => ({
    root: "/fixture/private",
    writePrivate: fixture.write,
    readPrivate: fixture.read,
    dispose: fixture.dispose,
  }),
}));
vi.mock("./acp-process.js", () => ({ createAcpProcessHost: fixture.createHost }));
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
const computer = {
  executable: "/fixture/native",
  workspace: "/fixture",
  profileParent: "/fixture",
};
beforeEach(() => {
  vi.resetAllMocks();
  fixture.createHost.mockReturnValue({ connect: fixture.connect });
  fixture.connect.mockResolvedValue({ request: fixture.request, close: fixture.close });
  fixture.request.mockImplementation(async (method) =>
    method === "initialize"
      ? { protocolVersion: 1 }
      : {
          sessionId: "fixture-session",
          models: {
            currentModelId: "fixture",
            availableModels: [{ modelId: "fixture", name: "Fixture" }],
          },
        },
  );
  fixture.read.mockImplementation(async (path) =>
    Buffer.from(profile.files.find((file) => file.path === path)!.data),
  );
});
describe("isolated native account model discovery", () => {
  it("restores a validated profile and captures it only after confirmed process exit", async () => {
    fixture.read.mockImplementation(async (path) => {
      expect(fixture.close).toHaveBeenCalledOnce();
      return Buffer.from(profile.files.find((file) => file.path === path)!.data);
    });
    const result = await discoverGoogleAcpCatalog(profile, computer, new AbortController().signal);
    expect(result.profile).toEqual(profile);
    expect(result.discovery.models).toEqual([{ id: "fixture", name: "Fixture" }]);
    expect(fixture.write).toHaveBeenCalledTimes(2);
    expect(fixture.request.mock.calls.map(([method]) => method)).toEqual([
      "initialize",
      "session/new",
    ]);
    expect(fixture.request.mock.calls[1]?.[1]).toEqual({
      cwd: "/fixture/private",
      mcpServers: [],
      _meta: { antigravity: { enabledTools: [] } },
    });
    expect(fixture.dispose).toHaveBeenCalledOnce();
    expect(fixture.createHost.mock.calls[0]?.[0].env.BROWSER).toBe("/bin/false");
  });
  it("retains private files and returns no snapshot on uncertain process cleanup", async () => {
    fixture.close.mockRejectedValue(new Error("fixture incomplete cleanup"));
    await expect(
      discoverGoogleAcpCatalog(profile, computer, new AbortController().signal),
    ).rejects.toThrow();
    expect(fixture.read).not.toHaveBeenCalled();
    expect(fixture.dispose).not.toHaveBeenCalled();
  });
  it("cleans the private profile if host connection failed", async () => {
    fixture.connect.mockRejectedValue(new Error("fixture connection failure"));
    await expect(
      discoverGoogleAcpCatalog(profile, computer, new AbortController().signal),
    ).rejects.toThrow();
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });
  it("denies all native permissions", async () => {
    await discoverGoogleAcpCatalog(profile, computer, new AbortController().signal);
    expect(await fixture.connect.mock.calls[0]?.[0].permission({})).toEqual({
      outcome: { outcome: "cancelled" },
    });
  });
  it("rejects invalid profile paths before writing any account state", async () => {
    await expect(
      discoverGoogleAcpCatalog(
        { ...profile, files: [{ path: "../escape", data: "fixture" }] },
        computer,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
    expect(fixture.write).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });
});
