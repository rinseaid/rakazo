import { describe, expect, it, vi } from "vitest";
import type { AcpSessionHost, AcpTransport } from "./acp-session.js";
import { AcpSession } from "./acp-session.js";

/** Protocol restoration only: these fixtures do not qualify native file persistence. */
function restoredSession(overrides: Record<string, unknown> = {}) {
  let handlers!: Parameters<AcpSessionHost["connect"]>[0];
  const approve = vi.fn(async () => true);
  const transport: AcpTransport = {
    request: vi.fn(async (method) => {
      if (method === "initialize")
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (method === "session/load")
        return {
          modes: { availableModes: [{ id: "default" }] },
          models: { availableModels: [{ modelId: "fixture-model" }] },
          ...overrides,
        };
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    }),
    notify: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  };
  const session = new AcpSession(
    {
      connect: async (value) => {
        handlers = value;
        return transport;
      },
      approve,
    },
    {
      cwd: "/workspace",
      modelId: "fixture-model",
      confirmationModeId: "default",
      resumeSessionId: "saved-session",
      mcpServers: [],
    },
  );
  return { session, transport, approve, handlers: () => handlers };
}

describe("restored ACP conversation safety", () => {
  it.each([
    { modes: { availableModes: [{ id: "unrestricted" }] } },
    { models: { availableModels: [{ modelId: "different-model" }] } },
  ])(
    "refuses stale mode/model availability without a fresh-session fallback: %j",
    async (state) => {
      const f = restoredSession(state);
      await expect(f.session.open()).rejects.toThrow("unavailable");
      expect(f.session.id).toBeUndefined();
      expect(f.transport.close).toHaveBeenCalledTimes(1);
      expect(vi.mocked(f.transport.request).mock.calls.map(([method]) => method)).not.toContain(
        "session/new",
      );
      await expect(f.session.prompt([], vi.fn())).rejects.toThrow("not ready");
    },
  );

  it.each(["session/set_mode", "session/set_model"])(
    "does not expose a resumable ID after %s fails",
    async (failure) => {
      const f = restoredSession();
      const request = vi.mocked(f.transport.request).getMockImplementation()!;
      vi.mocked(f.transport.request).mockImplementation(async (...args) => {
        if (args[0] === failure) throw new Error("negotiation failed");
        return request(...args);
      });
      await expect(f.session.open()).rejects.toThrow("negotiation failed");
      expect(f.session.id).toBeUndefined();
      expect(f.transport.close).toHaveBeenCalledTimes(1);
    },
  );

  it("does not treat loading a conversation as resuming a pending native permission", async () => {
    const f = restoredSession();
    const request = vi.mocked(f.transport.request).getMockImplementation()!;
    vi.mocked(f.transport.request).mockImplementation(async (...args) => {
      if (args[0] === "session/set_mode" || args[0] === "session/set_model") {
        expect(f.session.id).toBeUndefined();
        expect(
          await f.handlers().permission({
            sessionId: "saved-session",
            toolCall: { title: "Previously pending call" },
            options: [{ optionId: "once", kind: "allow_once" }],
          }),
        ).toEqual({ outcome: { outcome: "cancelled" } });
      }
      return request(...args);
    });
    await f.session.open();
    expect(f.approve).not.toHaveBeenCalled();
    await f.session.close();
  });

  it("closes a load cancelled before its response and never exposes its ID", async () => {
    const f = restoredSession();
    const controller = new AbortController();
    const request = vi.mocked(f.transport.request).getMockImplementation()!;
    vi.mocked(f.transport.request).mockImplementation(async (...args) => {
      const result = await request(...args);
      if (args[0] === "session/load") controller.abort();
      return result;
    });
    await expect(f.session.open(controller.signal)).rejects.toThrow();
    expect(f.session.id).toBeUndefined();
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });
});
