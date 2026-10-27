import type { Readable, Writable } from "node:stream";
import type { Tool, ToolResultMessage, TranscriptContext } from "@earendil-works/pi-ai";
import type { DuplexProcess, NativeModelProfile } from "@rakazo/adapter-kit";
import type { AcpConversationLifecycle } from "./acp-conversation.js";
import { parseAcpConversationState } from "./acp-conversation.js";
import type { HostedAcpProviderOptions, HostedAcpRun } from "./pi-acp-provider.js";
import { AcpProviderError } from "./pi-acp-provider.js";

type OpenInput = Parameters<HostedAcpProviderOptions["open"]>[0];
type Persist = (profile: NativeModelProfile) => Promise<boolean>;
const SAFE_FAILURE_KINDS = ["rate_limit", "unavailable", "auth", "context_limit"] as const;
type SafeFailureKind = (typeof SAFE_FAILURE_KINDS)[number];
function safeFailureKind(error: unknown, progressed: boolean): SafeFailureKind | undefined {
  if (progressed || !(error instanceof AcpProviderError)) return undefined;
  return SAFE_FAILURE_KINDS.find((kind) => kind === error.kind);
}
function receivedFailure(message: Message, progressed: boolean): AcpProviderError {
  return new AcpProviderError(
    !progressed && message.errorKind ? message.errorKind : "unknown_outcome",
  );
}

type Message = {
  type:
    | "init"
    | "prompt"
    | "text"
    | "toolCall"
    | "toolResult"
    | "persistProfile"
    | "persistResult"
    | "conversationCandidate"
    | "candidateResult"
    | "close"
    | "closed";
  id?: number;
  value?: unknown;
  done?: boolean;
  failed?: boolean;
  errorKind?: SafeFailureKind;
};
const MAX_FRAME = 8 * 1024 * 1024;
const MAX_QUEUED = 16 * 1024 * 1024;
const failure = () => new AcpProviderError("unknown_outcome");

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure()), 10_000);
        timer.unref();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  // A failure can arrive before the consumer starts awaiting.
  void promise.catch(() => {});
  return { promise, resolve, reject };
}

function writer(write: (data: Uint8Array) => Promise<void>) {
  let tail = Promise.resolve();
  let queued = 0;
  return (message: Message): Promise<void> => {
    let bytes: Buffer;
    try {
      bytes = Buffer.from(`${JSON.stringify(message)}\n`);
    } catch {
      return Promise.reject(failure());
    }
    if (bytes.length > MAX_FRAME || queued + bytes.length > MAX_QUEUED)
      return Promise.reject(failure());
    queued += bytes.length;
    const next = tail
      .then(async () => {
        for (let offset = 0; offset < bytes.length; offset += 65536)
          await write(bytes.subarray(offset, offset + 65536));
      })
      .finally(() => {
        queued -= bytes.length;
      });
    tail = next;
    void tail.catch(() => {});
    return next;
  };
}

async function* frames(chunks: AsyncIterable<Uint8Array | string>): AsyncGenerator<Message> {
  const buffer = Buffer.allocUnsafe(MAX_FRAME);
  let used = 0;
  for await (const chunk of chunks) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    // Consume incrementally, even if the transport batches several valid frames.
    let start = 0;
    while (start < bytes.length) {
      const newline = bytes.indexOf(10, start);
      const end = newline < 0 ? bytes.length : newline;
      if (used + end - start > MAX_FRAME) throw failure();
      bytes.copy(buffer, used, start, end);
      used += end - start;
      if (newline < 0) break;
      let message: Message;
      try {
        message = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, used)),
        );
        if (
          !message ||
          typeof message !== "object" ||
          ![
            "init",
            "prompt",
            "text",
            "toolCall",
            "toolResult",
            "persistProfile",
            "persistResult",
            "conversationCandidate",
            "candidateResult",
            "close",
            "closed",
          ].includes(message.type)
        )
          throw failure();
        if (
          message.errorKind !== undefined &&
          (message.failed !== true ||
            message.done !== true ||
            (message.type !== "init" && message.type !== "prompt") ||
            !SAFE_FAILURE_KINDS.includes(message.errorKind))
        )
          throw failure();
      } catch {
        throw failure();
      }
      used = 0;
      yield message;
      start = newline + 1;
    }
  }
  if (used) throw failure();
}

/** One private protocol channel, not a log stream. The caller selects/configures the helper. */
export async function openHostedRunRelay(
  process: DuplexProcess,
  input: OpenInput,
  persistProfile: Persist,
  initialization?: unknown,
  conversation?: AcpConversationLifecycle,
): Promise<HostedAcpRun> {
  try {
    if (Buffer.byteLength(JSON.stringify(initialization) ?? "null") > 144 * 1024) throw failure();
    if (conversation?.restore) parseAcpConversationState(conversation.restore);
  } catch {
    await process.close().catch(() => {});
    throw failure();
  }
  const send = writer((bytes) => process.write(bytes));
  const ready = deferred<void>();
  const closed = deferred<void>();
  let prompt: ReturnType<typeof deferred<void>> | undefined;
  let update: ((text: string) => void) | undefined;
  let closing: Promise<void> | undefined;
  let dead = false;
  let initialized = false;
  const calls = new Set<number>();
  let lastCall = 0;
  let conversationSaved = false;
  let promptCompleted = false;
  let observedProgress = false;
  const fail = () => {
    dead = true;
    ready.reject(failure());
    prompt?.reject(failure());
    closed.reject(failure());
    void process.close().catch(() => {});
  };
  const abort = () => {
    void close().catch(() => {});
  };
  const close = (): Promise<void> =>
    (closing ??= (async () => {
      input.signal.removeEventListener("abort", abort);
      try {
        if (dead) throw failure();
        await bounded(
          (async () => {
            await send({ type: "close" });
            await closed.promise;
            await process.end();
          })(),
        );
      } finally {
        prompt?.reject(failure());
        await process.close().catch(() => {
          throw failure();
        });
      }
    })());
  async function* stdout() {
    for await (const event of process.events) {
      if (event.type === "stdout") yield event.data;
      // Never surface stderr: native diagnostics can contain account state.
    }
  }
  void (async () => {
    try {
      for await (const message of frames(stdout())) {
        if (message.type === "init" && message.done === true && !initialized) {
          initialized = true;
          if (message.failed) ready.reject(receivedFailure(message, observedProgress));
          else ready.resolve();
        } else if (message.type === "text" && prompt && typeof message.value === "string") {
          observedProgress = true;
          update?.(message.value);
        } else if (message.type === "prompt" && message.done === true && prompt) {
          if (message.failed) prompt.reject(receivedFailure(message, observedProgress));
          else {
            promptCompleted = true;
            prompt.resolve();
          }
          prompt = undefined;
          update = undefined;
        } else if (
          (message.type === "toolCall" ||
            message.type === "persistProfile" ||
            message.type === "conversationCandidate") &&
          !dead
        ) {
          const id = message.id;
          if (!Number.isSafeInteger(id) || id! <= lastCall || calls.has(id!) || calls.size >= 32)
            throw failure();
          lastCall = id!;
          calls.add(id!);
          void (async () => {
            try {
              let value: unknown;
              if (message.type === "toolCall") {
                observedProgress = true;
                const call = message.value as { name: string; args: Record<string, unknown> };
                if (
                  !prompt ||
                  closing ||
                  typeof call?.name !== "string" ||
                  !input.tools.some((tool) => tool.name === call.name) ||
                  !call.args ||
                  typeof call.args !== "object" ||
                  Array.isArray(call.args)
                )
                  throw failure();
                value = await input.callTool(call.name, call.args);
              } else if (message.type === "conversationCandidate") {
                if (!conversation || !closing || prompt || !promptCompleted || conversationSaved)
                  throw failure();
                conversationSaved = true;
                await conversation.offerCandidate(parseAcpConversationState(message.value));
                value = true;
              } else value = await persistProfile(message.value as NativeModelProfile);
              await send({
                type:
                  message.type === "toolCall"
                    ? "toolResult"
                    : message.type === "conversationCandidate"
                      ? "candidateResult"
                      : "persistResult",
                id,
                value,
              });
            } catch {
              await send({
                type:
                  message.type === "toolCall"
                    ? "toolResult"
                    : message.type === "conversationCandidate"
                      ? "candidateResult"
                      : "persistResult",
                id,
                failed: true,
              });
            } finally {
              calls.delete(id!);
            }
          })().catch(fail);
        } else if (message.type === "closed" && closing) {
          if (message.failed) closed.reject(failure());
          else closed.resolve();
          dead = true;
          return;
        } else throw failure();
      }
      throw failure();
    } catch {
      fail();
    }
  })();
  void process.exited.then(() => {
    if (!dead) fail();
  }, fail);
  input.signal.addEventListener("abort", abort, { once: true });
  try {
    input.signal.throwIfAborted();
    await bounded(
      (async () => {
        await send({
          type: "init",
          value: {
            tools: input.tools,
            initialization,
            conversation: conversation?.restore,
            conversationEnabled: Boolean(conversation),
          },
        });
        await ready.promise;
      })(),
    );
    if (closing || dead) throw failure();
    return {
      close,
      async prompt(context, onText, signal) {
        if (prompt || closing || dead || signal.aborted) throw failure();
        const pending = deferred<void>();
        prompt = pending;
        update = onText;
        signal.addEventListener("abort", abort, { once: true });
        try {
          await send({ type: "prompt", value: context });
          await pending.promise;
        } catch (error) {
          // Classification only survives confirmed helper cleanup, never transport loss.
          try {
            await close();
          } catch {
            throw failure();
          }
          const kind = safeFailureKind(error, observedProgress);
          throw kind ? new AcpProviderError(kind) : failure();
        } finally {
          signal.removeEventListener("abort", abort);
        }
      },
    };
  } catch (error) {
    let classified = safeFailureKind(error, observedProgress);
    if (classified) {
      try {
        await close();
      } catch {
        classified = undefined;
      }
    }
    if (observedProgress) classified = undefined;
    fail();
    input.signal.removeEventListener("abort", abort);
    throw classified ? new AcpProviderError(classified) : failure();
  }
}

export interface HostedRunRelayHelperOptions {
  input: Readable;
  output: Writable;
  /** Trusted composition supplies native model/account/computer configuration. */
  createRun(input: {
    tools: readonly Tool[];
    initialization: unknown;
    callTool: OpenInput["callTool"];
    signal: AbortSignal;
    persistProfile: Persist;
    conversation?: AcpConversationLifecycle;
  }): Promise<HostedAcpRun>;
}

/** Owns one native run, not a second Pi provider or agent loop. */
export async function serveHostedRunRelay({
  input,
  output,
  createRun,
}: HostedRunRelayHelperOptions): Promise<void> {
  const send = writer(
    (bytes) =>
      new Promise<void>((resolve, reject) => {
        output.write(bytes, (error) => (error ? reject(failure()) : resolve()));
      }),
  );
  const outputError = () => input.destroy(failure());
  output.on("error", outputError);
  const controller = new AbortController();
  const pending = new Map<number, { kind: string; result: ReturnType<typeof deferred<unknown>> }>();
  let sequence = 0;
  let opening: Promise<HostedAcpRun> | undefined;
  let active: Promise<void> | undefined;
  let closing: Promise<void> | undefined;
  let initialized = false;
  let terminal = false;
  let closeFailed = false;
  let observedProgress = false;
  let promptCompleted = false;
  const abortRun = (rejectAll = false) => {
    controller.abort();
    for (const [id, entry] of pending) {
      if (rejectAll || entry.kind === "toolResult") {
        entry.result.reject(failure());
        pending.delete(id);
      }
    }
  };
  const inputClosed = () => {
    // A lost helper channel is cancellation, even if a normal close was in flight.
    if (!terminal) {
      if (closing) closeFailed = true;
      abortRun(true);
    }
  };
  input.on("close", inputClosed);
  const request = async (
    type: "toolCall" | "persistProfile" | "conversationCandidate",
    value: unknown,
  ) => {
    if (terminal || pending.size >= 32) throw failure();
    if (type === "toolCall") observedProgress = true;
    const id = ++sequence;
    const result = deferred<unknown>();
    pending.set(id, {
      kind:
        type === "toolCall"
          ? "toolResult"
          : type === "conversationCandidate"
            ? "candidateResult"
            : "persistResult",
      result,
    });
    try {
      await send({ type, id, value });
      return await result.promise;
    } finally {
      pending.delete(id);
    }
  };
  const cleanup = (normalFinish = false) => {
    if (closing) {
      if (!normalFinish) abortRun();
      return closing;
    }
    closing = (async () => {
      if (!normalFinish) abortRun();
      if (normalFinish) {
        await active?.catch(() => {});
        if (!promptCompleted || pending.size !== 0 || controller.signal.aborted) abortRun();
      }
      // Closing the native run may persist its profile; keep the reader alive.
      // A rejected open returned no run; its authoritative error was sent separately.
      const run = await opening?.catch(() => undefined);
      await run?.close();
      if (!normalFinish) await active?.catch(() => {});
    })();
    return closing;
  };
  try {
    for await (const message of frames(input)) {
      if (message.type === "init" && !opening && !terminal) {
        const init = message.value as {
          tools: Tool[];
          initialization: unknown;
          conversation?: unknown;
          conversationEnabled?: boolean;
        };
        if (
          !init ||
          !Array.isArray(init.tools) ||
          Buffer.byteLength(JSON.stringify(init.initialization) ?? "null") > 144 * 1024
        )
          throw failure();
        const restored =
          init.conversation === undefined
            ? undefined
            : parseAcpConversationState(init.conversation);
        opening = createRun({
          tools: init.tools,
          initialization: init.initialization,
          signal: controller.signal,
          conversation:
            init.conversationEnabled === true
              ? {
                  restore: restored,
                  offerCandidate: async (state) => {
                    if (!closing) throw failure();
                    const value = await request(
                      "conversationCandidate",
                      parseAcpConversationState(state),
                    );
                    if (value !== true) throw failure();
                  },
                }
              : undefined,
          callTool: async (name, args) =>
            (await request("toolCall", { name, args })) as ToolResultMessage,
          persistProfile: async (profile) => {
            const value = await request("persistProfile", profile);
            if (typeof value !== "boolean") throw failure();
            return value;
          },
        });
        void opening
          .then(
            async () => {
              initialized = true;
              await send({ type: "init", done: true });
            },
            async (error) => {
              await send({
                type: "init",
                done: true,
                failed: true,
                errorKind: safeFailureKind(error, observedProgress),
              });
            },
          )
          .catch(() => input.destroy(failure()));
      } else if (message.type === "prompt" && initialized && !active && !closing) {
        const context = message.value as TranscriptContext;
        if (!context || !Array.isArray(context.messages)) throw failure();
        // A prior completed prompt cannot qualify this new prompt while it runs.
        promptCompleted = false;
        active = (async () => {
          try {
            const run = await opening!;
            await run.prompt(
              context,
              (text) => {
                observedProgress = true;
                void send({ type: "text", value: text }).catch(() => input.destroy(failure()));
              },
              controller.signal,
            );
            promptCompleted = true;
            await send({ type: "prompt", done: true });
          } catch (error) {
            await send({
              type: "prompt",
              done: true,
              failed: true,
              errorKind: safeFailureKind(error, observedProgress),
            });
          }
        })();
        void active
          .finally(() => {
            active = undefined;
          })
          .catch(() => input.destroy(failure()));
      } else if (
        message.type === "toolResult" ||
        message.type === "persistResult" ||
        message.type === "candidateResult"
      ) {
        const entry = pending.get(message.id!);
        if (!entry || entry.kind !== message.type) throw failure();
        pending.delete(message.id!);
        if (message.failed) entry.result.reject(failure());
        else entry.result.resolve(message.value);
      } else if (message.type === "close" && !closing) {
        const normalFinish =
          // prompt-done bytes may reach the parent before the write callback settles.
          // cleanup waits for that active acknowledgement and then rechecks state.
          promptCompleted && pending.size === 0 && !controller.signal.aborted;
        void cleanup(normalFinish)
          .then(
            async () => {
              // Mark the intentional end before the parent closes its input pipe
              // in response to this acknowledgement.
              terminal = true;
              await send({ type: "closed", failed: closeFailed });
            },
            () => {
              closeFailed = true;
              terminal = true;
              return send({ type: "closed", failed: true });
            },
          )
          .then(() => {
            input.destroy();
          })
          .catch(() => input.destroy(failure()));
      } else throw failure();
    }
    if (!terminal || closeFailed) throw failure();
  } catch {
    if (!terminal || closeFailed) throw failure();
  } finally {
    const abnormalEnd = !terminal || closeFailed;
    terminal = true;
    input.removeListener("close", inputClosed);
    if (abnormalEnd) abortRun(true);
    for (const entry of pending.values()) entry.result.reject(failure());
    pending.clear();
    await cleanup(!abnormalEnd).catch(() => {});
    output.removeListener("error", outputError);
  }
}
