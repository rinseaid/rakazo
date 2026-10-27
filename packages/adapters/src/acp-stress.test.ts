import { PassThrough, Writable } from "node:stream";
import type { Model, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpToolRoundtrip } from "./acp-tool-roundtrip.js";
import { AcpStreamTransport } from "./acp-transport.js";
import type { HostedAcpProviderOptions } from "./pi-acp-provider.js";
import { AcpProviderError, createHostedAcpProvider } from "./pi-acp-provider.js";
import { PiAgentRuntime } from "./pi-runtime.js";

// Offline fault injection only: no vendor requests, real accounts, or host exhaustion.
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const model: Model<"acp"> = {
  id: "stress",
  name: "Offline stress",
  provider: "stress-acp",
  api: "acp",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({
  tools: [{ name: "write", description: "Synthetic side effect", parameters: Type.Object({}) }],
  messages: [{ role: "user", content: "fixture", timestamp: 1 }],
});
function provider(open: HostedAcpProviderOptions["open"], maxInputBytes?: number) {
  return createHostedAcpProvider({
    id: model.provider,
    maxInputBytes,
    name: "Offline",
    models: [model],
    auth: { apiKey: { name: "Offline", resolve: async () => undefined } },
    open,
  });
}
function result(call: ToolCall, text = "synthetic result"): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 2,
  };
}
afterEach(() => vi.useRealTimers());

describe("bounded offline prompt stress", () => {
  it("rejects a double-click while allowing the first prompt to finish once", async () => {
    let finish!: () => void;
    const close = vi.fn(async () => {});
    const open = vi.fn<HostedAcpProviderOptions["open"]>(async () => ({
      close,
      prompt: async (_context, emit) => {
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
        emit("one");
      },
    }));
    const bundle = provider(open);
    try {
      const first = bundle.provider.streamSimple(model, context).result();
      await tick();
      const duplicates = await Promise.all(
        Array.from({ length: 64 }, () => bundle.provider.streamSimple(model, context).result()),
      );
      expect(duplicates.every((message) => message.stopReason === "error")).toBe(true);
      finish();
      expect((await first).stopReason).toBe("stop");
      expect(open).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await bundle.close();
    }
  });

  it.each(["rate_limit", "unavailable"] as const)(
    "preserves a safe pre-execution %s classification without retrying itself",
    async (kind) => {
      const open = vi.fn<HostedAcpProviderOptions["open"]>(async () => {
        throw new AcpProviderError(kind);
      });
      const bundle = provider(open);
      try {
        const output = await bundle.provider.streamSimple(model, context).result();
        expect(output.stopReason).toBe("error");
        expect(output.errorMessage).toBe(new AcpProviderError(kind).message);
        expect(open).toHaveBeenCalledTimes(1);
      } finally {
        await bundle.close();
      }
    },
  );

  it.each(["rate_limit", "unavailable"] as const)(
    "does not advertise retry-safe %s after visible partial output",
    async (kind) => {
      let fail!: () => void;
      const bundle = provider(async () => ({
        close: async () => {},
        prompt: async (_context, emit) => {
          emit("visible partial answer");
          await new Promise<void>((_resolve, reject) => {
            fail = () => reject(new AcpProviderError(kind));
          });
        },
      }));
      try {
        const stream = bundle.provider.streamSimple(model, context);
        let observed = false;
        for await (const event of stream) {
          if (event.type === "text_delta") {
            observed = true;
            fail();
          }
        }
        expect(observed).toBe(true);
        const output = await stream.result();
        expect(output.stopReason).toBe("error");
        expect(output.errorMessage).toBe(new AcpProviderError("unknown_outcome").message);
      } finally {
        await bundle.close();
      }
    },
  );

  it("does not advertise retry safety after a tool side effect completed", async () => {
    const sideEffect = vi.fn();
    const open = vi.fn<HostedAcpProviderOptions["open"]>(async ({ callTool }) => ({
      close: async () => {},
      prompt: async () => {
        await callTool("write", {});
        throw new AcpProviderError("unavailable");
      },
    }));
    const bundle = provider(open);
    try {
      const first = await bundle.provider.streamSimple(model, context).result();
      const call = first.content[0];
      if (call?.type !== "toolCall") throw new Error("Expected tool call");
      sideEffect();
      const next = normalizeContext({ messages: [...context.messages, first, result(call)] });
      const last = await bundle.provider.streamSimple(model, next).result();
      expect(sideEffect).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledTimes(1);
      expect(last.stopReason).toBe("error");
      expect(last.errorMessage).toBe(new AcpProviderError("unknown_outcome").message);
    } finally {
      await bundle.close();
    }
  });

  it("roundtrips bounded large history, schemas and Unicode without loss", async () => {
    const unicode = "a\u0301🧪漢字\u0000\u202e";
    const large = normalizeContext({
      systemPrompt: unicode.repeat(64),
      tools: Array.from({ length: 24 }, (_, n) => ({
        name: `tool_${n}`,
        description: unicode.repeat(16),
        parameters: Type.Object({ value: Type.String() }),
      })),
      messages: Array.from({ length: 80 }, (_, n) => ({
        role: "user" as const,
        content: `${n}:${unicode.repeat(8)}`,
        timestamp: n,
      })),
    });
    const bundle = provider(async ({ tools }) => ({
      close: async () => {},
      prompt: async (received, emit) => {
        expect(received).toEqual(large);
        expect(tools).toHaveLength(24);
        emit(unicode);
      },
    }));
    try {
      const output = await bundle.provider
        .streamSimple({ ...model, contextWindow: 131072 }, large)
        .result();
      expect(output.stopReason).toBe("stop");
      expect(output.content).toEqual([{ type: "text", text: unicode }]);
    } finally {
      await bundle.close();
    }
  });

  it("reports provider context overflow honestly instead of fabricating success or silently dropping history", async () => {
    const large = normalizeContext({
      messages: [{ role: "user", content: "oversized fixture ".repeat(16384), timestamp: 1 }],
    });
    const observed = vi.fn();
    const bundle = provider(async () => ({
      close: async () => {},
      prompt: async (input) => {
        observed(input);
        throw new Error("synthetic context limit exceeded");
      },
    }));
    try {
      const output = await bundle.provider.streamSimple(model, large).result();
      expect(output.stopReason).toBe("error");
      expect(output.content).toEqual([]);
      expect(observed).toHaveBeenCalledWith(large);
    } finally {
      await bundle.close();
    }
  });

  it.each([-1, 0, 1])(
    "enforces serialized UTF-8 context boundary at limit offset %i without truncation",
    async (offset) => {
      const large = normalizeContext({
        messages: [{ role: "user", content: "🧪漢字".repeat(8192), timestamp: 1 }],
      });
      const size = Buffer.byteLength(JSON.stringify(large), "utf8");
      const observed = vi.fn();
      const open = vi.fn<HostedAcpProviderOptions["open"]>(async () => ({
        close: async () => {},
        prompt: async (input, emit) => {
          observed(input);
          emit("accepted");
        },
      }));
      const bundle = provider(open, size + offset);
      try {
        const output = await bundle.provider.streamSimple(model, large).result();
        if (offset < 0) {
          expect(output.stopReason).toBe("error");
          expect(output.content).toEqual([]);
          expect(open).not.toHaveBeenCalled();
        } else {
          expect(output.stopReason).toBe("stop");
          expect(observed).toHaveBeenCalledExactlyOnceWith(large);
        }
      } finally {
        await bundle.close();
      }
    },
  );

  it("rejects a 10001-message history before host allocation", async () => {
    const huge = normalizeContext({
      messages: Array.from({ length: 10001 }, (_, timestamp) => ({
        role: "user" as const,
        content: "x",
        timestamp,
      })),
    });
    const open = vi.fn<HostedAcpProviderOptions["open"]>();
    const bundle = provider(open);
    try {
      expect((await bundle.provider.streamSimple(model, huge).result()).stopReason).toBe("error");
      expect(open).not.toHaveBeenCalled();
    } finally {
      await bundle.close();
    }
  });

  it("rejects an oversized resumed tool result without delivering it or replaying the side effect", async () => {
    const received = vi.fn();
    let parked!: Promise<void>;
    const close = vi.fn(async () => {});
    const open = vi.fn<HostedAcpProviderOptions["open"]>(async ({ callTool }) => ({
      close,
      prompt: async () => {
        parked = callTool("write", {}).then(received, () => {});
        await parked;
      },
    }));
    const bundle = provider(open, 4096);
    try {
      const first = await bundle.provider.streamSimple(model, context).result();
      const call = first.content[0];
      if (call?.type !== "toolCall") throw new Error("Expected tool call");
      const next = normalizeContext({
        messages: [...context.messages, first, result(call, "🧪".repeat(4096))],
      });
      const final = await bundle.provider.streamSimple(model, next).result();
      await parked;
      expect(final.stopReason).toBe("error");
      expect(received).not.toHaveBeenCalled();
      expect(open).toHaveBeenCalledTimes(1);
      expect(close).toHaveBeenCalledTimes(1);
    } finally {
      await bundle.close();
    }
  });

  it("cancels a parked tool and rejects stale results rather than replaying it", async () => {
    const calls: ToolCall[] = [];
    const bridge = new AcpToolRoundtrip(new Set(["write"]), (call) => calls.push(call));
    const abort = new AbortController();
    const waiting = bridge.request("write", {}, abort.signal).then(
      () => "resolved",
      () => "rejected",
    );
    abort.abort();
    bridge.close();
    bridge.close();
    expect(await waiting).toBe("rejected");
    expect(bridge.accept(result(calls[0]!))).toBe(false);
    expect(calls).toHaveLength(1);
    expect(bridge.pendingCount).toBe(0);
  });

  it("clones a bounded large Unicode tool result and ignores a duplicated completion", async () => {
    let call!: ToolCall;
    const bridge = new AcpToolRoundtrip(new Set(["write"]), (value) => {
      call = value;
    });
    const waiting = bridge.request("write", {});
    const completed = result(call, "🧪漢字".repeat(32768));
    expect(bridge.accept(completed)).toBe(true);
    expect(bridge.accept(completed)).toBe(false);
    const received = await waiting;
    expect(received).toEqual(completed);
    expect(received).not.toBe(completed);
    bridge.close();
  });
});

function wire(output: Writable = new PassThrough(), timeout = 120000) {
  const input = new PassThrough();
  const stop = vi.fn(async () => {
    input.destroy();
    output.destroy();
  });
  const update = vi.fn();
  const transport = new AcpStreamTransport(
    input,
    output,
    { update, permission: async () => ({ outcome: { outcome: "cancelled" } }) },
    stop,
    timeout,
  );
  return { input, output, stop, transport, update };
}
describe("offline fragmented wire and hardware-fault models", () => {
  it("delivers UTF-8 frames fragmented at one byte over simulated 9.6 kbaud (~1 KB/s)", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = wire();
    let sent = "";
    f.output.on("data", (chunk) => {
      sent += chunk.toString();
    });
    try {
      const waiting = f.transport.request("_fixture", {});
      await tick();
      const id = JSON.parse(sent.trim()).id;
      const text = "e\u0301🧪漢字".repeat(80);
      const bytes = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, result: { text } })}\n`);
      // 1 millisecond per byte approximates framing overhead at 9600 baud.
      for (let offset = 0; offset < bytes.length; offset++) {
        f.input.write(bytes.subarray(offset, offset + 1));
        await vi.advanceTimersByTimeAsync(1);
      }
      expect(await waiting).toEqual({ text });
      expect(f.stop).not.toHaveBeenCalled();
    } finally {
      await f.transport.close();
    }
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it("times out a stalled half-frame without resending the request", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const f = wire(new PassThrough(), 2000);
    const writes: string[] = [];
    f.output.on("data", (chunk) => writes.push(chunk.toString()));
    try {
      const waiting = f.transport.request("_fixture", {}).then(
        () => "resolved",
        () => "rejected",
      );
      await tick();
      f.input.write('{"jsonrpc":"2.0","id":');
      await vi.advanceTimersByTimeAsync(2001);
      expect(await waiting).toBe("rejected");
      expect(writes).toHaveLength(1);
      expect(f.stop).toHaveBeenCalledTimes(1);
    } finally {
      await f.transport.close();
    }
  });

  it.each(["truncated process output", "invalid JSON bit flip"])(
    "rejects %s without claiming success",
    async (fault) => {
      const f = wire();
      f.output.on("data", () => {});
      try {
        const waiting = f.transport.request("_fixture", {}).then(
          () => "resolved",
          () => "rejected",
        );
        await tick();
        if (fault === "invalid JSON bit flip") f.input.write('{"jsonrpc":!"2.0"}\n');
        else f.input.write('{"jsonrpc":"2.0","result":');
        f.input.end();
        expect(await waiting).toBe("rejected");
        expect(f.stop).toHaveBeenCalledTimes(1);
      } finally {
        await f.transport.close();
      }
    },
  );

  it("rejects injected EIO while writing and never retries an uncertain transmission", async () => {
    const write = vi.fn((_chunk, _encoding, callback: (error?: Error) => void) =>
      callback(Object.assign(new Error("synthetic write fault"), { code: "EIO" })),
    );
    const output = new Writable({ write });
    const f = wire(output);
    try {
      const waiting = f.transport.request("_fixture", {}).then(
        () => "resolved",
        () => "rejected",
      );
      await tick();
      await tick();
      expect(await Promise.race([waiting, tick().then(() => "still pending")])).toBe("rejected");
      expect(write).toHaveBeenCalledTimes(1);
      expect(f.stop).toHaveBeenCalledTimes(1);
    } finally {
      await f.transport.close();
    }
  });
});

describe("real runtime outage recovery with synthetic hosted providers", () => {
  it.each(["partial text", "completed side effect"])(
    "never falls back or repeats execution after %s",
    async (phase) => {
      const backup = { ...model, id: "backup", provider: "stress-backup" };
      const changed = vi.fn(async () => {});
      const execute = vi.fn(async () => ({ content: "side effect completed" }));
      const opened: string[] = [];
      const closed = vi.fn(async () => {});
      const request: AgentRunRequest = {
        botId: "fixture",
        threadId: "fixture",
        runId: "fixture",
        prompt: "Synthetic operation",
        instructions: "Use scoped tools",
        history: [],
        tools: [
          {
            name: "write",
            description: "Synthetic write",
            inputSchema: { type: "object", properties: {} },
            readOnly: false,
          },
        ],
        executeTool: execute,
        model: {
          provider: model.provider,
          id: model.id,
          nativeAuth: {
            provider: model.provider,
            profile: { version: 1, files: [{ path: "account/state.json", data: "synthetic" }] },
            persist: async () => true,
          },
        },
        fallbackModels: [{ provider: backup.provider, id: backup.id }],
        resolveFallbackModel: async () => ({
          provider: backup.provider,
          id: backup.id,
          nativeAuth: {
            provider: backup.provider,
            profile: { version: 1, files: [{ path: "account/state.json", data: "synthetic" }] },
            persist: async () => true,
          },
        }),
        onModelChange: changed,
      };
      const runtime = new PiAgentRuntime({
        createProvider: (selected) => {
          const target = selected.provider === model.provider ? model : backup;
          return createHostedAcpProvider({
            id: target.provider,
            name: "Offline",
            models: [target],
            auth: {
              apiKey: { name: "Offline", resolve: async () => ({ auth: {}, source: "fixture" }) },
            },
            open: async ({ callTool }) => {
              opened.push(target.provider);
              return {
                close: closed,
                prompt: async (_context, emit) => {
                  if (phase === "completed side effect") await callTool("write", {});
                  else {
                    emit("partial output");
                    await tick();
                  }
                  if (target === model) throw new AcpProviderError("unavailable");
                  emit("backup must not run");
                },
              };
            },
          });
        },
      });
      const events: AgentRuntimeEvent[] = [];
      let failure: unknown;
      try {
        for await (const event of runtime.run(request)) events.push(event);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(opened).toEqual([model.provider]);
      expect(changed).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(phase === "completed side effect" ? 1 : 0);
      expect(closed).toHaveBeenCalledTimes(1);
      expect(
        events.some((event) => event.type === "text" && event.text === "backup must not run"),
      ).toBe(false);
    },
  );
});
