import { PassThrough } from "node:stream";
import type { Model } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai";
import type {
  AgentRunRequest,
  AgentRuntimeEvent,
  DuplexProcess,
  NativeModelProfile,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { HostedRunRelayHelperOptions } from "./acp-run-relay.js";
import { openHostedRunRelay, serveHostedRunRelay } from "./acp-run-relay.js";
import type { HostedAcpProviderOptions } from "./pi-acp-provider.js";
import { AcpProviderError, createHostedAcpProvider } from "./pi-acp-provider.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const profile: NativeModelProfile = { version: 1, files: [{ path: "fake.json", data: "fake" }] };
function harness(createRun: HostedRunRelayHelperOptions["createRun"]) {
  const input = new PassThrough();
  const output = new PassThrough();
  const serve = serveHostedRunRelay({ input, output, createRun });
  void serve.catch(() => {});
  const writes: number[] = [];
  const process: DuplexProcess = {
    events: (async function* (): AsyncGenerator<ProcessEvent> {
      for await (const data of output) yield { type: "stdout", data: data.toString() };
    })(),
    write: async (data) => {
      writes.push(data.length);
      await new Promise<void>((resolve, reject) =>
        input.write(data, (error) => (error ? reject(error) : resolve())),
      );
    },
    end: async () => {
      input.end();
    },
    exited: new Promise(() => {}),
    close: vi.fn(async () => {
      input.destroy();
      output.destroy();
    }),
  };
  return { process, input, output, serve, writes };
}
function openInput(
  signal = new AbortController().signal,
): Parameters<HostedAcpProviderOptions["open"]>[0] {
  return {
    model: {} as Parameters<HostedAcpProviderOptions["open"]>[0]["model"],
    tools: [{ name: "echo", description: "Echo", parameters: { type: "object", properties: {} } }],
    signal,
    options: {},
    callTool: vi.fn(async () => ({
      role: "toolResult" as const,
      toolCallId: "fake",
      toolName: "echo",
      content: [{ type: "text" as const, text: "result" }],
      isError: false,
      timestamp: 0,
    })),
  };
}

describe("hosted run relay", () => {
  it("transfers bounded native state separately from account profile initialization", async () => {
    const state = {
      version: 1 as const,
      sessionId: "fixture-session",
      data: Buffer.alloc(4 * 1024 * 1024, 7).toString("base64"),
    };
    const offerCandidate = vi.fn(async () => {});
    const persist = vi.fn(async () => true);
    const h = harness(async ({ conversation }) => {
      expect(conversation?.restore).toEqual(state);
      return {
        prompt: async () => {},
        close: async () => {
          await conversation!.offerCandidate(state);
        },
      };
    });
    const input = openInput();
    const run = await openHostedRunRelay(
      h.process,
      input,
      persist,
      { profile, padding: "x".repeat(140 * 1024) },
      { restore: state, offerCandidate },
    );
    await run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal);
    await run.close();
    await h.serve;
    expect(offerCandidate).toHaveBeenCalledExactlyOnceWith(state);
    expect(persist).not.toHaveBeenCalled();
    expect(Math.max(...h.writes)).toBeLessThanOrEqual(65536);
  });

  it("does not accept a conversation snapshot without a completed prompt", async () => {
    const state = {
      version: 1 as const,
      sessionId: "fixture-session",
      data: Buffer.from("opaque").toString("base64"),
    };
    const offerCandidate = vi.fn(async () => {});
    const h = harness(async ({ conversation }) => ({
      prompt: async () => {},
      close: async () => {
        await conversation!.offerCandidate(state);
      },
    }));
    const run = await openHostedRunRelay(h.process, openInput(), async () => true, undefined, {
      offerCandidate,
    });
    await expect(run.close()).rejects.toThrow("outcome is unknown");
    await h.serve.catch(() => {});
    expect(offerCandidate).not.toHaveBeenCalled();
  });

  it("transfers a completed tool-turn candidate for later application-history binding", async () => {
    const state = {
      version: 1 as const,
      sessionId: "fixture-session",
      data: Buffer.from("opaque").toString("base64"),
    };
    const offerCandidate = vi.fn(async () => {});
    const h = harness(async ({ conversation, callTool }) => ({
      prompt: async () => {
        await callTool("echo", {});
      },
      close: async () => {
        await conversation!.offerCandidate(state);
      },
    }));
    const input = openInput();
    const run = await openHostedRunRelay(h.process, input, async () => true, undefined, {
      offerCandidate,
    });
    await run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal);
    await run.close();
    await h.serve;
    expect(offerCandidate).toHaveBeenCalledExactlyOnceWith(state);
  });

  it("sanitizes a failed durable-state fence instead of reporting cleanup success", async () => {
    const state = {
      version: 1 as const,
      sessionId: "fixture-session",
      data: Buffer.from("opaque").toString("base64"),
    };
    const offerCandidate = vi.fn(async () => {
      throw new Error("private-storage-details");
    });
    const h = harness(async ({ conversation }) => ({
      prompt: async () => {},
      close: async () => {
        await conversation!.offerCandidate(state);
      },
    }));
    const input = openInput();
    const run = await openHostedRunRelay(h.process, input, async () => true, undefined, {
      offerCandidate,
    });
    await run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal);
    await expect(run.close()).rejects.toThrow("outcome is unknown");
    await h.serve.catch(() => {});
    expect(offerCandidate).toHaveBeenCalledTimes(1);
  });

  it("keeps tools upstream and profile persistence callback-based, with bounded writes", async () => {
    const input = openInput();
    const persist = vi.fn(async () => true);
    const nativeClose = vi.fn();
    const h = harness(async ({ tools, callTool, persistProfile, initialization }) => {
      expect(tools[0]?.name).toBe("echo");
      expect(initialization).toEqual({ profile });
      return {
        prompt: async (_context, update) => {
          expect(await callTool("echo", {})).toMatchObject({ toolName: "echo" });
          update("hello");
        },
        close: async () => {
          nativeClose();
          expect(await persistProfile(profile)).toBe(true);
        },
      };
    });
    const run = await openHostedRunRelay(h.process, input, persist, { profile });
    const update = vi.fn();
    await run.prompt(
      normalizeContext({
        messages: [{ role: "user", content: "a".repeat(140_000), timestamp: 0 }],
      }),
      update,
      input.signal,
    );
    await run.close();
    await h.serve;
    expect(input.callTool).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith("hello");
    expect(persist).toHaveBeenCalledWith(profile);
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(Math.max(...h.writes)).toBeLessThanOrEqual(65536);
  });

  it("keeps the helper run signal live through a completed remote close", async () => {
    let runSignal!: AbortSignal;
    const close = vi.fn(async () => {
      expect(runSignal.aborted).toBe(false);
    });
    const h = harness(async ({ signal }) => {
      runSignal = signal;
      return { prompt: async () => {}, close };
    });
    const input = openInput();
    const run = await openHostedRunRelay(h.process, input, async () => true);
    await run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal);
    await run.close();
    await h.serve;
    expect(close).toHaveBeenCalledOnce();
    expect(runSignal.aborted).toBe(false);
  });

  it("waits for the prompt acknowledgement write before a completed remote close", async () => {
    class DelayedPromptDoneStream extends PassThrough {
      callback: ((error?: Error | null) => void) | undefined;

      override _write(
        chunk: Buffer,
        _encoding: BufferEncoding,
        callback: (error?: Error | null) => void,
      ): void {
        this.push(chunk);
        if (chunk.toString().includes('"type":"prompt","done":true')) this.callback = callback;
        else callback();
      }
    }

    const input = new PassThrough();
    const output = new DelayedPromptDoneStream();
    let runSignal!: AbortSignal;
    const close = vi.fn(async () => {
      expect(runSignal.aborted).toBe(false);
    });
    const serve = serveHostedRunRelay({
      input,
      output,
      createRun: async ({ signal }) => {
        runSignal = signal;
        return { prompt: async () => {}, close };
      },
    });
    void serve.catch(() => {});
    const process: DuplexProcess = {
      events: (async function* (): AsyncGenerator<ProcessEvent> {
        for await (const data of output) yield { type: "stdout", data: data.toString() };
      })(),
      write: async (data) => {
        await new Promise<void>((resolve, reject) =>
          input.write(data, (error) => (error ? reject(error) : resolve())),
        );
      },
      end: async () => {
        input.end();
      },
      exited: new Promise(() => {}),
      close: vi.fn(async () => {
        input.destroy();
        output.destroy();
      }),
    };
    const request = openInput();
    const run = await openHostedRunRelay(process, request, async () => true);
    await run.prompt(normalizeContext({ messages: [] }), () => {}, request.signal);

    expect(output.callback).toBeDefined();
    let closeSettled = false;
    const closing = run.close().finally(() => {
      closeSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeSettled).toBe(false);
    expect(runSignal.aborted).toBe(false);
    expect(close).not.toHaveBeenCalled();

    output.callback?.();
    await closing;
    await serve;
    expect(runSignal.aborted).toBe(false);
    expect(close).toHaveBeenCalledOnce();
  });

  it("aborts the helper run when its channel disconnects during graceful close", async () => {
    let runSignal!: AbortSignal;
    let closeStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      closeStarted = resolve;
    });
    const close = vi.fn(async () => {
      closeStarted();
      if (!runSignal.aborted) {
        await new Promise<void>((resolve) =>
          runSignal.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
    });
    const h = harness(async ({ signal }) => {
      runSignal = signal;
      return { prompt: async () => {}, close };
    });
    const input = openInput();
    const run = await openHostedRunRelay(h.process, input, async () => true);
    await run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal);
    const closing = run.close();
    await started;
    h.input.destroy();
    await expect(closing).rejects.toThrow("outcome is unknown");
    await h.serve.catch(() => {});
    expect(runSignal.aborted).toBe(true);
    expect(close).toHaveBeenCalledOnce();
  });

  it("sanitizes native failures without replaying the prompt", async () => {
    const nativePrompt = vi.fn(async () => {
      throw new Error("fake-private-diagnostic");
    });
    const h = harness(async () => ({ prompt: nativePrompt, close: async () => {} }));
    const input = openInput();
    const run = await openHostedRunRelay(h.process, input, async () => true);
    await expect(
      run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal),
    ).rejects.toThrow("outcome is unknown");
    expect(nativePrompt).toHaveBeenCalledOnce();
    await h.serve.catch(() => {});
  });

  it("rejects oversized input before writing any of its frame", async () => {
    const h = harness(async () => ({ prompt: async () => {}, close: async () => {} }));
    const input = openInput();
    const run = await openHostedRunRelay(h.process, input, async () => true);
    const before = h.writes.length;
    await expect(
      run.prompt(
        normalizeContext({
          messages: [{ role: "user", content: "a".repeat(9 * 1024 * 1024), timestamp: 0 }],
        }),
        () => {},
        input.signal,
      ),
    ).rejects.toThrow("outcome is unknown");
    expect(h.writes.slice(before)).toEqual([
      Buffer.byteLength(`${JSON.stringify({ type: "close" })}\n`),
    ]);
    await h.serve.catch(() => {});
  });

  it("closes native resources on truncated EOF", async () => {
    const close = vi.fn(async () => {});
    const h = harness(async () => ({ prompt: async () => {}, close }));
    await openHostedRunRelay(h.process, openInput(), async () => true);
    h.input.end('{"type":');
    await expect(h.serve).rejects.toThrow("outcome is unknown");
    expect(close).toHaveBeenCalledOnce();
    h.output.destroy();
  });

  it("aborts a parked tool call and still persists during close", async () => {
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const controller = new AbortController();
    const input = openInput(controller.signal);
    input.callTool = async () => {
      startedResolve();
      return new Promise(() => {});
    };
    const persist = vi.fn(async () => true);
    const h = harness(async ({ callTool, persistProfile }) => ({
      prompt: async () => {
        await callTool("echo", {});
      },
      close: async () => {
        await persistProfile(profile);
      },
    }));
    const run = await openHostedRunRelay(h.process, input, persist);
    const prompt = run.prompt(normalizeContext({ messages: [] }), () => {}, controller.signal);
    void prompt.catch(() => {});
    await started;
    controller.abort();
    await expect(prompt).rejects.toThrow("outcome is unknown");
    await run.close();
    await h.serve;
    expect(persist).toHaveBeenCalledOnce();
  });
  it("rejects malformed frames without surfacing their contents", async () => {
    const h = harness(async () => ({ prompt: async () => {}, close: async () => {} }));
    const input = openInput();
    const run = await openHostedRunRelay(h.process, input, async () => true);
    h.output.write("not-json-private-diagnostic\n");
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal),
    ).rejects.toThrow("outcome is unknown");
    await h.serve.catch(() => {});
  });

  it("reports failed native cleanup to both ends", async () => {
    const h = harness(async () => ({
      prompt: async () => {},
      close: async () => {
        throw new Error("private");
      },
    }));
    const run = await openHostedRunRelay(h.process, openInput(), async () => true);
    await expect(run.close()).rejects.toThrow("outcome is unknown");
    await expect(h.serve).rejects.toThrow("outcome is unknown");
  });

  it("does not write oversized initialization", async () => {
    const create = vi.fn(async () => ({ prompt: async () => {}, close: async () => {} }));
    const h = harness(create);
    await expect(
      openHostedRunRelay(h.process, openInput(), async () => true, "x".repeat(144 * 1024)),
    ).rejects.toThrow("outcome is unknown");
    expect(h.writes).toEqual([]);
    expect(create).not.toHaveBeenCalled();
    await h.serve.catch(() => {});
  });
});

describe("hosted failure authority", () => {
  it.each(["rate_limit", "unavailable", "auth", "context_limit"] as const)(
    "preserves authoritative %s before output, including initialization failures",
    async (kind) => {
      for (const phase of ["init", "prompt"]) {
        const h = harness(async () => {
          if (phase === "init") throw new AcpProviderError(kind);
          return {
            prompt: async () => {
              throw new AcpProviderError(kind);
            },
            close: async () => {},
          };
        });
        const input = openInput();
        const operation = async () => {
          const run = await openHostedRunRelay(h.process, input, async () => true);
          await run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal);
        };
        await expect(operation()).rejects.toMatchObject({ kind });
        await h.serve;
        expect(h.process.close).toHaveBeenCalled();
      }
    },
  );

  it.each(["text", "tool"] as const)(
    "downgrades classified failure after %s progress",
    async (progress) => {
      const h = harness(async ({ callTool }) => ({
        prompt: async (_context, text) => {
          if (progress === "text") text("partial response");
          else await callTool("echo", {});
          throw new AcpProviderError("unavailable");
        },
        close: async () => {},
      }));
      const input = openInput();
      const run = await openHostedRunRelay(h.process, input, async () => true);
      await expect(
        run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal),
      ).rejects.toMatchObject({ kind: "unknown_outcome" });
      await h.serve;
    },
  );

  it("does not infer retry authority from diagnostic prose or unconfirmed cleanup", async () => {
    for (const cleanupFails of [false, true]) {
      const h = harness(async () => ({
        prompt: async () => {
          throw cleanupFails
            ? new AcpProviderError("rate_limit")
            : new Error("private diagnostic 429 503 context_limit");
        },
        close: async () => {
          if (cleanupFails) throw new Error("private cleanup diagnostic");
        },
      }));
      const input = openInput();
      const run = await openHostedRunRelay(h.process, input, async () => true);
      await expect(
        run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal),
      ).rejects.toMatchObject({ kind: "unknown_outcome" });
      await h.serve.catch(() => {});
    }
  });

  it("rejects unrecognized wire error kinds rather than trusting remote strings", async () => {
    const h = harness(async () => ({ prompt: async () => {}, close: async () => {} }));
    const input = openInput();
    const run = await openHostedRunRelay(h.process, input, async () => true);
    h.output.write(
      `${JSON.stringify({
        type: "prompt",
        done: true,
        failed: true,
        errorKind: "private diagnostic 429",
      })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    await expect(
      run.prompt(normalizeContext({ messages: [] }), () => {}, input.signal),
    ).rejects.toMatchObject({ kind: "unknown_outcome" });
    await h.serve.catch(() => {});
  });

  it.each(["rate_limit", "unavailable", "text", "tool"] as const)(
    "integrates %s with the existing runtime fallback without repeating partial work",
    async (mode) => {
      const primary: Model<"acp"> = {
        id: "primary",
        provider: "offline-relay",
        name: "Relay",
        api: "acp",
        baseUrl: "",
        input: ["text"],
        reasoning: false,
        contextWindow: 32768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
      const backup = { ...primary, provider: "offline-backup", id: "backup" };
      const changed = vi.fn(async () => {});
      const execute = vi.fn(async () => ({ content: "fixture result" }));
      const input: AgentRunRequest = {
        botId: "bot",
        threadId: "thread",
        runId: "run",
        prompt: "Read fixture",
        instructions: "Use tools",
        history: [],
        tools: [
          {
            name: "echo",
            description: "Echo",
            inputSchema: { type: "object", properties: {} },
            readOnly: true,
          },
        ],
        model: {
          provider: primary.provider,
          id: primary.id,
          nativeAuth: { provider: primary.provider, profile, persist: async () => true },
        },
        fallbackModels: [{ provider: backup.provider, id: backup.id }],
        resolveFallbackModel: async () => ({
          provider: backup.provider,
          id: backup.id,
          nativeAuth: { provider: backup.provider, profile, persist: async () => true },
        }),
        onModelChange: changed,
        executeTool: execute,
      };
      const attempts = vi.fn();
      const helpers: ReturnType<typeof harness>[] = [];
      const runtime = new PiAgentRuntime({
        createProvider: (config) => {
          const target = config.provider === primary.provider ? primary : backup;
          return createHostedAcpProvider({
            id: target.provider,
            name: "Fixture",
            models: [target],
            auth: {
              apiKey: { name: "Fixture", resolve: async () => ({ auth: {}, source: "fixture" }) },
            },
            open: async (scope) => {
              attempts(target.provider);
              const h = harness(async ({ callTool }) => ({
                close: async () => {},
                prompt: async (_context, text) => {
                  if (target === backup) {
                    text("Backup worked.");
                    return;
                  }
                  if (mode === "text") text("Partial answer.");
                  if (mode === "tool") await callTool("echo", {});
                  throw new AcpProviderError(mode === "rate_limit" ? "rate_limit" : "unavailable");
                },
              }));
              helpers.push(h);
              return openHostedRunRelay(h.process, scope, async () => true);
            },
          });
        },
      });
      const events: AgentRuntimeEvent[] = [];
      const run = async () => {
        for await (const event of runtime.run(input)) events.push(event);
      };
      if (mode === "text" || mode === "tool")
        await expect(run()).rejects.toThrow("outcome is unknown");
      else await run();
      if (mode === "rate_limit" || mode === "unavailable") {
        expect(changed).toHaveBeenCalledWith(backup.provider, backup.id);
        expect(
          events.some((event) => event.type === "text" && event.text.includes("Backup worked")),
        ).toBe(true);
      } else {
        expect(changed).not.toHaveBeenCalled();
        expect(attempts.mock.calls.every(([provider]) => provider === primary.provider)).toBe(true);
        expect(attempts).toHaveBeenCalledOnce();
        expect(execute).toHaveBeenCalledTimes(mode === "tool" ? 1 : 0);
      }
      await Promise.all(helpers.map((h) => h.serve.catch(() => {})));
    },
    15_000,
  );
});
