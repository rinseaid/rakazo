import { PassThrough } from "node:stream";
import type { Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import type { AdapterContext } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { persistAcpProfile, restoreAcpProfile } from "./acp-profile.js";
import type { AcpSessionHost, AcpTransport } from "./acp-session.js";
import { AcpSession } from "./acp-session.js";
import { AcpToolRoundtrip } from "./acp-tool-roundtrip.js";
import { AcpStreamTransport } from "./acp-transport.js";
import type { HostedAcpProviderOptions } from "./pi-acp-provider.js";
import { createHostedAcpProvider } from "./pi-acp-provider.js";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function sessionFixture() {
  let handlers!: Parameters<AcpSessionHost["connect"]>[0];
  let finish!: (value: unknown) => void;
  const transport: AcpTransport = {
    request: vi.fn(async (method, _params, signal) => {
      if (method === "initialize") return { protocolVersion: 1 };
      if (method === "session/new")
        return {
          sessionId: "owned-session",
          modes: { availableModes: [{ id: "confirm" }, { id: "unrestricted" }] },
          models: { availableModels: [{ modelId: "fixture" }] },
        };
      if (method === "session/prompt")
        return new Promise((resolve, reject) => {
          finish = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
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
    },
    {
      cwd: "/workspace",
      modelId: "fixture",
      confirmationModeId: "confirm",
      mcpServers: [],
    },
  );
  return {
    session,
    transport,
    handlers: () => handlers,
    finish: () => finish({ stopReason: "end_turn" }),
  };
}
const model: Model<"acp"> = {
  id: "fixture",
  name: "Fixture",
  provider: "fixture-acp",
  api: "acp",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({
  tools: [{ name: "read", description: "Read", parameters: Type.Object({}) }],
  messages: [{ role: "user", content: "fixture", timestamp: 1 }],
});
function provider(open: HostedAcpProviderOptions["open"]) {
  return createHostedAcpProvider({
    id: model.provider,
    name: "Fixture",
    models: [model],
    auth: { apiKey: { name: "Fixture", resolve: async () => undefined } },
    open,
  });
}
function result(call: ToolCall): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: "fixture" }],
    isError: false,
    timestamp: 1,
  };
}

describe("ACP chaos regressions", () => {
  it.each([
    { sessionUpdate: "current_mode_update", currentModeId: "unrestricted" },
    {
      sessionUpdate: "config_option_update",
      configOptions: [
        {
          id: "mode",
          name: "Mode",
          type: "select",
          category: "mode",
          currentValue: "unrestricted",
          options: [{ value: "unrestricted", name: "Unrestricted" }],
        },
      ],
    },
  ])(
    "fails closed when the owned agent drifts out of confirmation mode: $sessionUpdate",
    async (update) => {
      const f = sessionFixture();
      await f.session.open();
      const prompt = f.session
        .prompt([], () => {})
        .then(
          () => "resolved",
          () => "rejected",
        );
      try {
        f.handlers().update({ sessionId: "owned-session", update });
        await tick();
        expect(f.transport.close).toHaveBeenCalledTimes(1);
        expect(await prompt).toBe("rejected");
      } finally {
        await f.session.close();
        await prompt;
      }
    },
  );

  it("does not retain an unrestricted mode change between prompts", async () => {
    const f = sessionFixture();
    await f.session.open();
    try {
      f.handlers().update({
        sessionId: "owned-session",
        update: {
          sessionUpdate: "current_mode_update",
          currentModeId: "unrestricted",
        },
      });
      await tick();
      expect(f.transport.close).toHaveBeenCalledTimes(1);
      await expect(f.session.prompt([], () => {})).rejects.toThrow();
    } finally {
      await f.session.close();
    }
  });

  it("closes an active session exactly once even when abort callbacks re-enter close", async () => {
    const f = sessionFixture();
    await f.session.open();
    const prompt = f.session
      .prompt([], () => {})
      .then(
        () => "resolved",
        () => "rejected",
      );
    await Promise.all([f.session.close(), f.session.close()]);
    expect(await prompt).toBe("rejected");
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });

  it("does not allow another session's mode updates to terminate the authorized prompt", async () => {
    const f = sessionFixture();
    await f.session.open();
    const update = vi.fn();
    const prompt = f.session.prompt([], update);
    f.handlers().update({
      sessionId: "foreign-session",
      update: { sessionUpdate: "current_mode_update", currentModeId: "unrestricted" },
    });
    expect(update).not.toHaveBeenCalled();
    expect(f.transport.close).not.toHaveBeenCalled();
    f.finish();
    await prompt;
    await Promise.all([f.session.close(), f.session.close()]);
    expect(f.transport.close).toHaveBeenCalledTimes(1);
  });

  it("releases the host and rejects parked tools when its prompt fails, without waiting for another Pi stream", async () => {
    let fail!: (error: Error) => void;
    let parked!: Promise<string>;
    const close = vi.fn(async () => {});
    const bundle = provider(async ({ callTool }) => ({
      close,
      prompt: async () => {
        parked = callTool("read", {}).then(
          () => "resolved",
          () => "rejected",
        );
        await new Promise<never>((_resolve, reject) => {
          fail = reject;
        });
      },
    }));
    try {
      expect((await bundle.provider.streamSimple(model, context).result()).stopReason).toBe(
        "toolUse",
      );
      fail(new Error("synthetic peer terminated"));
      await tick();
      expect(close).toHaveBeenCalledTimes(1);
      expect(await Promise.race([parked, tick().then(() => "still parked")])).toBe("rejected");
    } finally {
      await bundle.close();
    }
  });

  it("does not deliver a successful late result into a prompt that has already failed", async () => {
    let fail!: (error: Error) => void;
    const delivered = vi.fn();
    const bundle = provider(async ({ callTool }) => ({
      close: async () => {},
      prompt: async () => {
        void callTool("read", {}).then(delivered, () => {});
        await new Promise<never>((_resolve, reject) => {
          fail = reject;
        });
      },
    }));
    try {
      const first = await bundle.provider.streamSimple(model, context).result();
      const call = first.content[0]!;
      if (call.type !== "toolCall") throw new Error("Expected tool call");
      fail(new Error("synthetic terminal failure"));
      await tick();
      const next = normalizeContext({ messages: [...context.messages, first, result(call)] });
      expect((await bundle.provider.streamSimple(model, next).result()).stopReason).toBe("error");
      await tick();
      expect(delivered).not.toHaveBeenCalled();
    } finally {
      await bundle.close();
    }
  });

  it("settles every queued tool exactly once under alternating abort, result, and double-close", async () => {
    const calls: ToolCall[] = [];
    const bridge = new AcpToolRoundtrip(new Set(["read"]), (call) => calls.push(call), 1000, 128);
    const controllers = Array.from({ length: 96 }, () => new AbortController());
    const waiting = controllers.map((controller, n) =>
      bridge.request("read", { n }, controller.signal).then(
        () => "resolved",
        () => "rejected",
      ),
    );
    for (let n = calls.length - 1; n >= 0; n--) {
      if (n % 3 === 0) controllers[n]!.abort();
      else if (n % 3 === 1) {
        expect(bridge.accept(result(calls[n]!))).toBe(true);
        expect(bridge.accept(result(calls[n]!))).toBe(false);
        controllers[n]!.abort();
      }
    }
    bridge.close();
    bridge.close();
    const outcomes = await Promise.all(waiting);
    expect(outcomes.filter((value) => value === "resolved")).toHaveLength(32);
    expect(outcomes.filter((value) => value === "rejected")).toHaveLength(64);
    for (const call of calls) expect(bridge.accept(result(call))).toBe(false);
  });

  it.each(["bytes", "queue"])("fails closed on streamed output %s overflow", async (kind) => {
    const close = vi.fn(async () => {});
    const bundle = provider(async () => ({
      close,
      prompt: async (_context, emit) => {
        if (kind === "bytes") emit("🌋".repeat(2 * 1024 * 1024 + 1));
        else for (let i = 0; i < 4097; i++) emit("x");
      },
    }));
    try {
      const output = await bundle.provider.streamSimple(model, context).result();
      expect(output.stopReason).toBe("error");
      expect(output.content).toEqual([]);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await bundle.close();
    }
  });

  it("never opens a host for a pre-aborted provider request", async () => {
    const open = vi.fn<HostedAcpProviderOptions["open"]>();
    const bundle = provider(open);
    const controller = new AbortController();
    controller.abort();
    expect(
      (await bundle.provider.streamSimple(model, context, { signal: controller.signal }).result())
        .stopReason,
    ).toBe("aborted");
    expect(open).not.toHaveBeenCalled();
    await Promise.all([bundle.close(), bundle.close()]);
  });
});

const profileContext: AdapterContext = {
  spaceId: "fixture",
  userId: "fixture",
  operationId: "fixture",
  traceId: "fixture",
  signal: new AbortController().signal,
};
function profileFiles() {
  return {
    readPrivate: vi.fn(async () => Buffer.from("synthetic profile")),
    writePrivate: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
}
describe("ACP profile transaction chaos", () => {
  it("cleans up a leased profile when required-path configuration is invalid", async () => {
    const files = profileFiles();
    const store = { put: vi.fn(), delete: vi.fn() };
    await expect(
      persistAcpProfile({
        files,
        store,
        context: profileContext,
        recordId: "fixture",
        allowedPaths: ["account"],
        requiredPaths: ["other"],
        commit: async () => true,
      }),
    ).rejects.toThrow();
    expect(files.dispose).toHaveBeenCalledTimes(1);
    expect(store.put).not.toHaveBeenCalled();
  });

  it("cleans up a leased profile when restoration is pre-aborted", async () => {
    const files = profileFiles();
    const load = vi.fn();
    const controller = new AbortController();
    controller.abort();
    await expect(
      restoreAcpProfile({
        files,
        store: { load },
        secretRef: "fixture",
        recordId: "fixture",
        allowedPaths: ["account"],
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(files.dispose).toHaveBeenCalledTimes(1);
    expect(load).not.toHaveBeenCalled();
  });

  it("only the winning writer survives simultaneous stale-profile CAS attempts", async () => {
    let current = "old";
    let sequence = 0;
    const live = new Set(["old"]);
    const store = {
      put: vi.fn(async () => {
        const ref = `new-${++sequence}`;
        live.add(ref);
        await tick();
        return { id: ref, ref, ciphertext: "synthetic" };
      }),
      delete: vi.fn(async (ref: string) => {
        live.delete(ref);
      }),
    };
    const leases = [profileFiles(), profileFiles()];
    const outcomes = await Promise.allSettled(
      leases.map((files) =>
        persistAcpProfile({
          files,
          store,
          context: profileContext,
          recordId: "fixture",
          allowedPaths: ["account"],
          requiredPaths: ["account"],
          previousRef: "old",
          commit: async (next, previous) => {
            if (current !== previous) return false;
            current = next;
            await tick();
            return true;
          },
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(live).toEqual(new Set([current]));
    for (const files of leases) expect(files.dispose).toHaveBeenCalledTimes(1);
  });

  it("never deletes committed state if disposal fails after successful CAS", async () => {
    const files = profileFiles();
    files.dispose.mockRejectedValue(new Error("synthetic cleanup failure"));
    const store = {
      put: vi.fn(async () => ({ id: "new", ref: "new", ciphertext: "synthetic" })),
      delete: vi.fn(async () => {}),
    };
    await expect(
      persistAcpProfile({
        files,
        store,
        context: profileContext,
        recordId: "fixture",
        allowedPaths: ["account"],
        requiredPaths: ["account"],
        previousRef: "old",
        commit: async () => true,
      }),
    ).rejects.toThrow("cleanup failed");
    expect(store.delete).toHaveBeenCalledExactlyOnceWith("old", "fixture");
  });
});

describe("ACP SDK wire chaos", () => {
  it("correlates reversed responses and ignores duplicate replies without cross-delivery", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const sent: Array<{ id: string | number; params: { n: number } }> = [];
    let buffer = "";
    output.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n");
        sent.push(JSON.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
    const stop = vi.fn(async () => {
      input.end();
      output.end();
    });
    const transport = new AcpStreamTransport(
      input,
      output,
      { update: () => {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) },
      stop,
      1000,
    );
    try {
      const waiting = Array.from({ length: 32 }, (_, n) => transport.request("_fixture", { n }));
      await tick();
      expect(sent).toHaveLength(32);
      for (const request of [...sent].reverse()) {
        const response =
          JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { n: request.params.n } }) +
          "\n";
        // Exercise chunk fragmentation as well as response reordering.
        input.write(response.slice(0, 7));
        input.write(response.slice(7));
        input.write(response);
      }
      expect(await Promise.all(waiting)).toEqual(Array.from({ length: 32 }, (_, n) => ({ n })));
    } finally {
      await Promise.all([transport.close(), transport.close()]);
    }
    expect(stop).toHaveBeenCalledTimes(1);
  });
});
