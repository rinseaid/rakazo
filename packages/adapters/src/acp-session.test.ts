import { describe, expect, it, vi } from "vitest";
import type { AcpSessionHost, AcpTransport } from "./acp-session.js";
import { AcpSession } from "./acp-session.js";

function fixture(
  approve?: AcpSessionHost["approve"],
  agentCapabilities: Record<string, unknown> = {},
) {
  let handlers!: Parameters<AcpSessionHost["connect"]>[0];
  let finish!: (value: unknown) => void;
  const transport: AcpTransport = {
    request: vi.fn(async (method, _params, signal) => {
      if (method === "initialize") return { protocolVersion: 1, agentCapabilities };
      if (method === "session/new")
        return {
          sessionId: "session-1",
          modes: { availableModes: [{ id: "default" }] },
          models: { availableModels: [{ modelId: "test-model" }] },
        };
      if (method === "session/prompt")
        return new Promise((resolve, reject) => {
          finish = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      return {};
    }),
    notify: vi.fn(async () => {}),
    finishGracefully: vi.fn(async () => ({ clean: true, stopped: true })),
    close: vi.fn(async () => {}),
  };
  const host: AcpSessionHost = {
    connect: vi.fn(async (value) => {
      handlers = value;
      return transport;
    }),
    approve,
  };
  const session = new AcpSession(host, {
    cwd: "/workspace",
    modelId: "test-model",
    confirmationModeId: "default",
    mcpServers: [],
    permissionTimeoutMs: 10,
  });
  return {
    session,
    host,
    transport,
    handlers: () => handlers,
    finish: (stopReason = "end_turn") => finish({ stopReason }),
  };
}
const permission = {
  sessionId: "session-1",
  toolCall: { title: "test" },
  options: [
    { optionId: "always", kind: "allow_always" },
    { optionId: "once", kind: "allow_once" },
  ],
};
const denied = { outcome: { outcome: "cancelled" } };

describe("ACP session boundary", () => {
  it("allows idempotent graceful finish only after end_turn", async () => {
    const f = fixture();
    await f.session.open();
    expect(await f.session.finishGracefully()).toEqual({ clean: false, stopped: false });
    const prompt = f.session.prompt([], () => {});
    f.finish();
    await prompt;
    expect(await Promise.all([f.session.finishGracefully(), f.session.finishGracefully()])).toEqual(
      [
        { clean: true, stopped: true },
        { clean: true, stopped: true },
      ],
    );
    expect(f.transport.finishGracefully).toHaveBeenCalledTimes(1);
    await f.session.close();
  });

  it.each(["max_tokens", "max_turn_requests", "refusal"])(
    "allows graceful finish after the completed %s stop reason",
    async (stopReason) => {
      const f = fixture();
      await f.session.open();
      const prompt = f.session.prompt([], () => {});
      f.finish(stopReason);
      await prompt;
      expect(await f.session.finishGracefully()).toEqual({ clean: true, stopped: true });
      expect(f.transport.finishGracefully).toHaveBeenCalledTimes(1);
      await f.session.close();
    },
  );

  it("selects confirmation mode before the requested model", async () => {
    const f = fixture();
    await f.session.open();
    expect(vi.mocked(f.transport.request).mock.calls.map(([method]) => method)).toEqual([
      "initialize",
      "session/new",
      "session/set_mode",
      "session/set_model",
    ]);
    expect(f.transport.request).toHaveBeenCalledWith(
      "session/set_mode",
      { sessionId: "session-1", modeId: "default" },
      expect.any(AbortSignal),
    );
    await f.session.close();
  });

  it("applies a requested thought level using the advertised ACP option", async () => {
    const f = fixture();
    const thoughtLevel = {
      id: "thought-level",
      name: "Thinking",
      category: "thought_level",
      type: "select",
      currentValue: "low",
      options: [
        { value: "low", name: "Low" },
        { value: "high", name: "High" },
      ],
    };
    vi.mocked(f.transport.request).mockImplementation(async (method, params) => {
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new")
        return {
          sessionId: "session-1",
          modes: { availableModes: [{ id: "default" }] },
          models: { availableModels: [{ modelId: "test-model" }] },
          configOptions: [thoughtLevel],
        };
      if (method === "session/set_config_option")
        return {
          configOptions: [{ ...thoughtLevel, currentValue: params.value }],
        };
      return {};
    });
    const session = new AcpSession(f.host, {
      cwd: "/workspace",
      modelId: "test-model",
      thinkingLevel: "high",
      confirmationModeId: "default",
      mcpServers: [],
    });
    await session.open();
    expect(f.transport.request).toHaveBeenCalledWith(
      "session/set_config_option",
      { sessionId: "session-1", configId: "thought-level", value: "high" },
      expect.any(AbortSignal),
    );
    await session.close();
  });

  it("reports image prompt support only when the agent advertises it", async () => {
    const f = fixture(undefined, { promptCapabilities: { image: true } });
    await f.session.open();
    expect(f.session.supportsImagePrompt).toBe(true);
    await f.session.close();
  });

  it("sends image blocks unchanged in a prompt when advertised", async () => {
    const f = fixture(undefined, { promptCapabilities: { image: true } });
    await f.session.open();
    const content = [{ type: "image", data: "AA==", mimeType: "image/png" }];
    const prompt = f.session.prompt(content, () => {});
    expect(f.transport.request).toHaveBeenCalledWith(
      "session/prompt",
      { sessionId: "session-1", prompt: content },
      expect.any(AbortSignal),
    );
    f.finish();
    await prompt;
    await f.session.close();
  });

  it("denies native execution without an approval handler", async () => {
    const f = fixture();
    await f.session.open();
    const prompt = f.session.prompt([], () => {});
    expect(await f.handlers().permission(permission)).toEqual(denied);
    f.finish();
    await prompt;
    await f.session.close();
  });

  it("only grants a single call after explicit approval", async () => {
    const approve = vi.fn(async () => true);
    const f = fixture(approve);
    await f.session.open();
    expect(await f.handlers().permission(permission)).toEqual(denied);
    const prompt = f.session.prompt([], () => {});
    expect(await f.handlers().permission({ ...permission, sessionId: "another-bot" })).toEqual(
      denied,
    );
    expect(await f.handlers().permission(permission)).toEqual({
      outcome: { outcome: "selected", optionId: "once" },
    });
    expect(approve).toHaveBeenCalledTimes(1);
    f.finish();
    await prompt;
    await f.session.close();
  });

  it("never upgrades to allow-always", async () => {
    const f = fixture(async () => true);
    await f.session.open();
    const prompt = f.session.prompt([], () => {});
    expect(
      await f.handlers().permission({ ...permission, options: [permission.options[0]!] }),
    ).toEqual(denied);
    f.finish();
    await prompt;
    await f.session.close();
  });

  it("fails closed on approval errors and timeouts", async () => {
    for (const approve of [
      async () => {
        throw new Error("unavailable");
      },
      () => new Promise<boolean>(() => {}),
    ]) {
      const f = fixture(approve);
      await f.session.open();
      const prompt = f.session.prompt([], () => {});
      expect(await f.handlers().permission(permission)).toEqual(denied);
      f.finish();
      await prompt;
      await f.session.close();
    }
  });

  it("cancels pending permissions when the turn ends", async () => {
    const f = fixture(() => new Promise<boolean>(() => {}));
    await f.session.open();
    const prompt = f.session.prompt([], () => {});
    const answer = f.handlers().permission(permission);
    f.finish();
    await prompt;
    expect(await answer).toEqual(denied);
    await f.session.close();
  });

  it("filters updates from other sessions and completed turns", async () => {
    const f = fixture();
    await f.session.open();
    const update = vi.fn();
    const prompt = f.session.prompt([], update);
    f.handlers().update({ sessionId: "other", update: { text: "secret" } });
    f.handlers().update({ sessionId: "session-1", update: { text: "hello" } });
    f.finish();
    await prompt;
    f.handlers().update({ sessionId: "session-1", update: { text: "late" } });
    expect(update).toHaveBeenCalledExactlyOnceWith({ text: "hello" });
    await f.session.close();
  });

  it("cancels and closes the transport on abort", async () => {
    const f = fixture();
    await f.session.open();
    const controller = new AbortController();
    const prompt = f.session.prompt([], () => {}, controller.signal);
    const result = expect(prompt).rejects.toThrow();
    controller.abort();
    await result;
    await f.session.close();
    expect(f.transport.notify).toHaveBeenCalledWith("session/cancel", { sessionId: "session-1" });
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });

  it("refuses concurrent prompts", async () => {
    const f = fixture();
    await f.session.open();
    const prompt = f.session.prompt([], () => {});
    await expect(f.session.prompt([], () => {})).rejects.toThrow("not ready");
    f.finish();
    await prompt;
    await f.session.close();
  });

  it("closes a connection that arrives after cancellation", async () => {
    const f = fixture();
    let complete!: (transport: AcpTransport) => void;
    vi.mocked(f.host.connect).mockImplementation(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    const controller = new AbortController();
    const opened = f.session.open(controller.signal);
    const result = expect(opened).rejects.toThrow();
    controller.abort();
    complete(f.transport);
    await result;
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });

  it("closes on malformed or unsupported session setup", async () => {
    const f = fixture();
    vi.mocked(f.transport.request).mockResolvedValue({ protocolVersion: 99 });
    await expect(f.session.open()).rejects.toThrow("Unsupported ACP");
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });
});

describe("ACP native session loading", () => {
  const options = {
    cwd: "/workspace",
    modelId: "test-model",
    confirmationModeId: "default",
    mcpServers: [],
    resumeSessionId: "saved-session",
  };
  it("loads the existing ID and revalidates mode/model without replaying history", async () => {
    const f = fixture();
    const approve = vi.fn(async () => true);
    f.host.approve = approve;
    vi.mocked(f.transport.request).mockImplementation(async (method) => {
      if (method === "initialize")
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (method === "session/load") {
        f.handlers().update({
          sessionId: "saved-session",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "old output" },
          },
        });
        expect(
          await f.handlers().permission({ ...permission, sessionId: "saved-session" }),
        ).toEqual(denied);
        return {
          modes: { availableModes: [{ id: "default" }] },
          models: { availableModels: [{ modelId: "test-model" }] },
        };
      }
      if (method === "session/prompt") return { stopReason: "end_turn" };
      return {};
    });
    const session = new AcpSession(f.host, options);
    expect(session.id).toBeUndefined();
    await session.open();
    expect(session.id).toBe("saved-session");
    expect(f.transport.request).toHaveBeenCalledWith(
      "session/load",
      {
        sessionId: "saved-session",
        cwd: "/workspace",
        mcpServers: [],
      },
      expect.any(AbortSignal),
    );
    expect(vi.mocked(f.transport.request).mock.calls.map(([method]) => method)).toEqual([
      "initialize",
      "session/load",
      "session/set_mode",
      "session/set_model",
    ]);
    const output = vi.fn();
    await session.prompt([{ type: "text", text: "new prompt" }], output);
    expect(output).not.toHaveBeenCalled();
    expect(approve).not.toHaveBeenCalled();
    await session.close();
    expect(session.id).toBeUndefined();
  });
  it("resends fresh host metadata and MCP endpoints when loading", async () => {
    const f = fixture();
    vi.mocked(f.transport.request).mockImplementation(async (method) => {
      if (method === "initialize")
        return {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } },
        };
      if (method === "session/load")
        return {
          modes: { availableModes: [{ id: "default" }] },
          models: { availableModels: [{ modelId: "test-model" }] },
        };
      return {};
    });
    const creationMetadata = {
      fixture: { systemPrompt: "fresh instructions", eagerServers: ["fresh-bridge"] },
    };
    const mcpServers = [{ type: "http", name: "fresh-bridge", url: "http://127.0.0.1:1234/mcp" }];
    const session = new AcpSession(f.host, { ...options, creationMetadata, mcpServers });
    await session.open();
    expect(f.transport.request).toHaveBeenCalledWith(
      "session/load",
      {
        sessionId: "saved-session",
        cwd: "/workspace",
        mcpServers,
        _meta: creationMetadata,
      },
      expect.any(AbortSignal),
    );
    await session.close();
  });
  it("does not silently create a new session when loading is unsupported", async () => {
    const f = fixture();
    vi.mocked(f.transport.request).mockResolvedValue({ protocolVersion: 1, agentCapabilities: {} });
    const session = new AcpSession(f.host, options);
    await expect(session.open()).rejects.toThrow("cannot restore");
    expect(f.transport.request).toHaveBeenCalledTimes(1);
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });
  it("does not recreate or replay after a failed load", async () => {
    const f = fixture();
    vi.mocked(f.transport.request).mockImplementation(async (method) => {
      if (method === "initialize")
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      throw new Error("load failed");
    });
    const session = new AcpSession(f.host, options);
    await expect(session.open()).rejects.toThrow("load failed");
    expect(vi.mocked(f.transport.request).mock.calls.map(([method]) => method)).toEqual([
      "initialize",
      "session/load",
    ]);
    expect(session.id).toBeUndefined();
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });
});
