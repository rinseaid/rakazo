import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGoogleAcpLogin } from "./google-acp-login.js";

const fixture = vi.hoisted(() => ({
  dispose: vi.fn(),
  close: vi.fn(),
  request: vi.fn(),
  connect: vi.fn(),
  writePrivate: vi.fn(),
}));
vi.mock("node:fs/promises", () => ({ chmod: vi.fn() }));
vi.mock("./acp-local-profile.js", () => ({
  createAcpLocalProfile: async () => ({
    root: "/fixture/private",
    writePrivate: fixture.writePrivate,
    dispose: fixture.dispose,
  }),
}));
vi.mock("./acp-process.js", () => ({
  createAcpProcessHost: () => ({ connect: fixture.connect }),
}));

const input = () => ({
  provider: "google-antigravity",
  loginId: "fixture-login",
  actor: { userId: "fixture-user", spaceId: "fixture-space" },
  signal: new AbortController().signal,
  interaction: { notify: vi.fn(), prompt: vi.fn() },
});
const login = createGoogleAcpLogin({ executable: "/fixture/agent", profileParent: "/fixture" });

beforeEach(() => {
  vi.resetAllMocks();
  fixture.connect.mockResolvedValue({ request: fixture.request, close: fixture.close });
});

describe("native login lifecycle", () => {
  it.each([undefined, 0, 2, "1"])(
    "rejects unsupported protocol %s before authentication",
    async (protocolVersion) => {
      fixture.request.mockResolvedValue({
        protocolVersion,
        authMethods: [{ id: "oauth-personal" }],
      });
      const request = input();
      await expect(login(request)).rejects.toThrow("Google sign-in did not complete");
      expect(fixture.request.mock.calls.map(([method]) => method)).toEqual(["initialize"]);
      expect(request.interaction.notify).not.toHaveBeenCalled();
      expect(fixture.close).toHaveBeenCalledOnce();
      expect(fixture.dispose).toHaveBeenCalledOnce();
    },
  );

  it("retains the private profile if native termination cannot be confirmed", async () => {
    fixture.request.mockRejectedValue(new Error("synthetic initialization failure"));
    fixture.close.mockRejectedValue(new Error("Process cleanup incomplete"));
    await expect(login(input())).rejects.toThrow("Process cleanup incomplete");
    expect(fixture.dispose).not.toHaveBeenCalled();
  });

  it("disposes the profile when connecting fails before a process is returned", async () => {
    fixture.connect.mockRejectedValue(new Error("synthetic connection failure"));
    await expect(login(input())).rejects.toThrow("Google sign-in did not complete");
    expect(fixture.dispose).toHaveBeenCalledOnce();
  });

  it("does not prepare a profile for an already-cancelled login", async () => {
    const request = input();
    request.signal = AbortSignal.abort();
    await expect(login(request)).rejects.toThrow();
    expect(fixture.writePrivate).not.toHaveBeenCalled();
    expect(fixture.connect).not.toHaveBeenCalled();
  });
});
