import type { Model, ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import type { HostedAcpProviderOptions } from "./pi-acp-provider.js";
import { createHostedAcpProvider } from "./pi-acp-provider.js";

const model: Model<"acp"> = {
  id: "test",
  name: "test",
  provider: "test-acp",
  api: "acp",
  baseUrl: "",
  reasoning: false,
  input: ["text"],
  contextWindow: 8192,
  maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const context = normalizeContext({
  systemPrompt: "instructions",
  tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
  messages: [{ role: "user", content: "test", timestamp: 1 }],
});
function create(open: HostedAcpProviderOptions["open"]) {
  return createHostedAcpProvider({
    id: model.provider,
    name: "Test ACP",
    models: [model],
    auth: { apiKey: { name: "Test", resolve: async () => undefined } },
    open,
  });
}

describe("hosted ACP Pi provider", () => {
  it("returns a normal Pi model and streamed assistant response", async () => {
    const close = vi.fn(async () => {});
    const bundle = create(async () => ({
      close,
      prompt: async (input, text) => {
        expect(input).toEqual(context);
        text("hello");
      },
    }));
    expect(bundle.provider.getModels()).toEqual([model]);
    const stream = bundle.provider.streamSimple(model, context);
    const events = [];
    for await (const event of stream) events.push(event);
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "text_start",
      "text_delta",
      "text_end",
      "done",
    ]);
    expect((await stream.result()).content).toEqual([{ type: "text", text: "hello" }]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps the hosted signal live through close after normal completion", async () => {
    const events: string[] = [];
    let hostedSignal!: AbortSignal;
    const bundle = create(async ({ signal }) => {
      hostedSignal = signal;
      signal.addEventListener("abort", () => events.push("abort"), { once: true });
      return {
        close: async () => {
          events.push(signal.aborted ? "close-aborted" : "close-live");
        },
        prompt: async (_context, text) => {
          text("complete");
        },
      };
    });

    const result = await bundle.provider.streamSimple(model, context).result();

    expect(result.stopReason).toBe("stop");
    expect(events).toEqual(["close-live", "abort"]);
    expect(hostedSignal.aborted).toBe(true);
  });

  it("escalates an external abort that arrives during normal close", async () => {
    const events: string[] = [];
    let hostedSignal!: AbortSignal;
    let started!: () => void;
    const closeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const bundle = create(async ({ signal }) => {
      hostedSignal = signal;
      signal.addEventListener("abort", () => events.push("abort"), { once: true });
      return {
        close: async () => {
          events.push(signal.aborted ? "close-aborted" : "close-live");
          started();
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        prompt: async (_context, text) => {
          text("complete");
        },
      };
    });
    const external = new AbortController();
    const result = bundle.provider
      .streamSimple(model, context, { signal: external.signal })
      .result();

    await closeStarted;
    external.abort();
    expect((await result).stopReason).toBe("stop");
    expect(events).toEqual(["close-live", "abort"]);
    expect(hostedSignal.aborted).toBe(true);
  });

  it("yields a real Pi tool call and resumes only with its actual result", async () => {
    const close = vi.fn(async () => {});
    const received = vi.fn();
    const open = vi.fn<HostedAcpProviderOptions["open"]>(async ({ callTool }) => ({
      close,
      prompt: async (_context, text) => {
        const result = await callTool("read", { path: "sample" });
        received(result);
        text("finished");
      },
    }));
    const bundle = create(open);
    const first = await bundle.provider.streamSimple(model, context).result();
    expect(first.stopReason).toBe("toolUse");
    const call = first.content[0]!;
    if (call.type !== "toolCall") throw new Error("Expected tool call");
    expect(received).not.toHaveBeenCalled();
    const result: ToolResultMessage = {
      role: "toolResult",
      toolName: call.name,
      toolCallId: call.id,
      content: [{ type: "text", text: "denied by policy" }],
      isError: true,
      timestamp: 2,
    };
    const next = normalizeContext({ messages: [...context.messages, first, result] });
    const final = await bundle.provider.streamSimple(model, next).result();
    expect(final.stopReason).toBe("stop");
    expect(received).toHaveBeenCalledWith(result);
    expect(open).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("fails closed when the caller omits a requested tool result", async () => {
    const close = vi.fn(async () => {});
    const bundle = create(async ({ callTool }) => ({
      close,
      prompt: async () => {
        await callTool("read", {});
      },
    }));
    const first = await bundle.provider.streamSimple(model, context).result();
    const final = await bundle.provider
      .streamSimple(model, normalizeContext({ messages: [...context.messages, first] }))
      .result();
    expect(final.stopReason).toBe("error");
    expect(close).toHaveBeenCalled();
  });

  it("rejects cross-provider models without opening a process", async () => {
    const open = vi.fn<HostedAcpProviderOptions["open"]>();
    const bundle = create(open);
    expect(
      (await bundle.provider.streamSimple({ ...model, provider: "other" }, context).result())
        .stopReason,
    ).toBe("error");
    expect(open).not.toHaveBeenCalled();
  });

  it("sanitizes failures without returning raw runtime secrets", async () => {
    const bundle = create(async () => {
      throw new Error("fake-secret-must-not-leak");
    });
    const result = await bundle.provider.streamSimple(model, context).result();
    expect(result.stopReason).toBe("error");
    expect(JSON.stringify(result)).not.toContain("fake-secret");
    await bundle.close();
  });
  it("aborts a resumed stream using that stream's signal", async () => {
    const close = vi.fn(async () => {});
    const bundle = create(async ({ callTool }) => ({
      close,
      prompt: async () => {
        await callTool("read", {});
        await new Promise<void>(() => {});
      },
    }));
    const first = await bundle.provider.streamSimple(model, context).result();
    const call = first.content[0]!;
    if (call.type !== "toolCall") throw new Error("Expected call");
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [],
      isError: false,
      timestamp: 2,
    };
    const controller = new AbortController();
    const stream = bundle.provider.streamSimple(
      model,
      normalizeContext({ messages: [...context.messages, first, result] }),
      { signal: controller.signal },
    );
    await Promise.resolve();
    controller.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("does not replay a failed prompt while a Pi tool was running", async () => {
    let fail!: (reason: Error) => void;
    const open = vi.fn<HostedAcpProviderOptions["open"]>(async ({ callTool }) => ({
      close: async () => {},
      prompt: async () => {
        await Promise.race([
          callTool("read", {}),
          new Promise<never>((_, reject) => {
            fail = reject;
          }),
        ]);
      },
    }));
    const bundle = create(open);
    const first = await bundle.provider.streamSimple(model, context).result();
    const call = first.content[0]!;
    if (call.type !== "toolCall") throw new Error("Expected call");
    fail(new Error("fake transport failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result: ToolResultMessage = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [],
      isError: false,
      timestamp: 2,
    };
    const final = await bundle.provider
      .streamSimple(model, normalizeContext({ messages: [...context.messages, first, result] }))
      .result();
    expect(final.stopReason).toBe("error");
    expect(open).toHaveBeenCalledTimes(1);
  });

  it("settles promptly when opening ignores cancellation, and closes its late result", async () => {
    let finish!: (run: Awaited<ReturnType<HostedAcpProviderOptions["open"]>>) => void;
    const bundle = create(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const stream = bundle.provider.streamSimple(model, context, { signal: controller.signal });
    controller.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    const close = vi.fn(async () => {});
    finish({ close, prompt: vi.fn() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(close).toHaveBeenCalledTimes(1);
  });
});
