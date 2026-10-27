import { createHash } from "node:crypto";
import type {
  AssistantMessage,
  Model,
  Provider,
  SimpleStreamOptions,
  Tool,
  ToolCall,
  ToolResultMessage,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { AcpToolRoundtrip } from "./acp-tool-roundtrip.js";

/** Classified by the vendor adapter only when the outcome is safe to retry. */
export class AcpProviderError extends Error {
  constructor(
    readonly kind: "rate_limit" | "unavailable" | "auth" | "context_limit" | "unknown_outcome",
  ) {
    super(
      kind === "rate_limit"
        ? "ACP provider rate limit (429)"
        : kind === "unavailable"
          ? "503: ACP provider unavailable"
          : kind === "auth"
            ? "ACP authentication required (401)"
            : kind === "context_limit"
              ? "ACP input exceeds the configured context byte limit"
              : "ACP execution outcome is unknown; do not retry automatically",
    );
    this.name = "AcpProviderError";
  }
}

/** A scoped, authenticated ACP run hosted by an isolated account process. */
export interface HostedAcpRun {
  prompt(
    context: TranscriptContext,
    update: (text: string) => void,
    signal: AbortSignal,
  ): Promise<void>;
  close(): Promise<void>;
}

export interface HostedAcpProviderOptions {
  id: string;
  name: string;
  /** Exact serialized transcript bound; oversized input fails before any host action. */
  maxInputBytes?: number;
  models: readonly Model<"acp">[];
  /** Reuse the connection's actual auth implementation, never a synthetic OAuth marker. */
  auth: Provider["auth"];
  /** A provider instance belongs to one run/account, not a global catalog singleton. */
  open(input: {
    model: Model<"acp">;
    tools: readonly Tool[];
    callTool(name: string, args: Record<string, unknown>): Promise<ToolResultMessage>;
    signal: AbortSignal;
    options: SimpleStreamOptions;
    /** Exact initial transcript, used only by private conversation-state composition. */
    context?: TranscriptContext;
  }): Promise<HostedAcpRun>;
}

interface Active {
  key: string;
  controller: AbortController;
  bridge: AcpToolRoundtrip;
  run?: HostedAcpRun;
  queue: Array<
    { text: string } | { tool: ToolCall } | { done: true } | { failed: true; error: unknown }
  >;
  wake?: () => void;
  waiting: Set<string>;
  finished: boolean;
  normalCompletion: boolean;
  terminalError?: { error: unknown };
  closing?: Promise<void>;
  cleanup(): void;
}

/**
 * Provider-level adapter: Pi still executes every bridged call. ACP owns the
 * parked prompt only until Pi supplies tool results. Hosts must separately
 * enforce native ACP tool policy; this module does not imply sandboxing.
 */
export function createHostedAcpProvider(config: HostedAcpProviderOptions): {
  provider: Provider<"acp">;
  close(): Promise<void>;
} {
  const maxInputBytes = config.maxInputBytes ?? 2 * 1024 * 1024;
  if (
    !Number.isSafeInteger(maxInputBytes) ||
    maxInputBytes <= 0 ||
    maxInputBytes > 16 * 1024 * 1024
  )
    throw new Error("Invalid ACP input byte limit");
  let active: Active | undefined;
  let streaming = false;
  let disposed = false;

  async function release(binding: Active, retainTerminal = false, force = false): Promise<void> {
    if (active === binding && !retainTerminal) active = undefined;
    if (binding.closing) {
      if (force || retainTerminal) binding.controller.abort();
      return binding.closing;
    }
    const graceful =
      !force &&
      !retainTerminal &&
      binding.normalCompletion &&
      binding.finished &&
      !binding.terminalError &&
      binding.waiting.size === 0 &&
      binding.bridge.pendingCount === 0 &&
      !binding.controller.signal.aborted;
    binding.closing = (async () => {
      try {
        await binding.run?.close();
      } finally {
        if (graceful) binding.controller.abort();
      }
    })();
    if (!graceful) binding.controller.abort();
    binding.bridge.close();
    if (!graceful) binding.cleanup();
    binding.wake?.();
    try {
      await binding.closing;
    } finally {
      if (graceful) binding.cleanup();
    }
  }

  function stream(
    model: Model<"acp">,
    context: TranscriptContext,
    options: SimpleStreamOptions = {},
  ): AssistantMessageEventStream {
    const output = new AssistantMessageEventStream();
    const message: AssistantMessage = {
      role: "assistant",
      api: "acp",
      provider: config.id,
      model: model.id,
      content: [],
      stopReason: "pending",
      timestamp: Date.now(),
      // ACP has no portable token accounting. Zero means unavailable here, not free usage.
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    const fail = (aborted: boolean, error?: unknown) => {
      message.stopReason = aborted ? "aborted" : "error";
      message.errorMessage = aborted
        ? "ACP request aborted"
        : error instanceof AcpProviderError
          ? error.message
          : "ACP provider failed";
      output.push({ type: "error", reason: message.stopReason, error: message });
    };
    if (streaming || disposed) {
      fail(false);
      return output;
    }
    streaming = true;
    void (async () => {
      let binding: Active | undefined = active;
      const abortStream = () => {
        if (binding) void release(binding, false, true).catch(() => undefined);
      };
      options.signal?.addEventListener("abort", abortStream, { once: true });
      try {
        options.signal?.throwIfAborted();
        if (
          context.messages.length > 10000 ||
          Buffer.byteLength(JSON.stringify(context), "utf8") > maxInputBytes
        )
          throw new AcpProviderError("context_limit");
        if (model.provider !== config.id || !config.models.some((entry) => entry.id === model.id))
          throw new Error("Unknown ACP model");
        const tools = getCurrentTools(context.messages);
        const key = JSON.stringify([
          model.id,
          options.apiKey ? createHash("sha256").update(options.apiKey).digest("hex") : undefined,
          options.sessionId,
          getCurrentSystemPrompt(context.messages),
          tools,
        ]);
        if (active && active.key !== key) {
          binding = active;
          throw new Error("ACP continuation changed model, account or tools");
        }
        binding = active;
        if (!binding) {
          const controller = new AbortController();
          const queue: Active["queue"] = [];
          let outputBytes = 0;
          let observedProgress = false;
          const emitText = (text: string) => {
            if (controller.signal.aborted) return;
            if (text) observedProgress = true;
            outputBytes += Buffer.byteLength(text, "utf8");
            if (outputBytes > 8 * 1024 * 1024 || queue.length >= 4096) {
              void release(pending).catch(() => undefined);
              return;
            }
            queue.push({ text });
            pending.wake?.();
          };
          const pending: Active = {
            key,
            controller,
            queue,
            waiting: new Set(),
            finished: false,
            normalCompletion: false,
            bridge: new AcpToolRoundtrip(new Set(tools.map((tool) => tool.name)), (tool) => {
              observedProgress = true;
              queue.push({ tool });
              pending.wake?.();
            }),
            cleanup: () => options.signal?.removeEventListener("abort", abort),
          };
          const abort = () => {
            void release(pending, false, true).catch(() => undefined);
          };
          options.signal?.addEventListener("abort", abort, { once: true });
          active = binding = pending;
          output.push({ type: "start", partial: message });
          const opening = config.open({
            model,
            context,
            tools,
            options,
            signal: controller.signal,
            callTool: (name, args) => pending.bridge.request(name, args, controller.signal),
          });
          const lateSafe = opening.then(async (run) => {
            if (controller.signal.aborted) {
              await run.close();
              throw new Error("aborted");
            }
            pending.run = run;
            return run;
          });
          const run = await raceAbort(lateSafe, controller.signal);
          const terminate = (error: unknown) => {
            if (
              observedProgress &&
              error instanceof AcpProviderError &&
              (error.kind === "rate_limit" || error.kind === "unavailable")
            )
              error = new AcpProviderError("unknown_outcome");
            pending.finished = true;
            pending.terminalError = { error };
            queue.length = 0;
            queue.push({ failed: true, error });
            void release(pending, true).catch(() => undefined);
            pending.wake?.();
          };
          void run.prompt(context, emitText, controller.signal).then(() => {
            if (pending.bridge.pendingCount) {
              terminate(new AcpProviderError("unknown_outcome"));
              return;
            }
            pending.finished = true;
            queue.push({ done: true });
            pending.wake?.();
          }, terminate);
        } else {
          output.push({ type: "start", partial: message });
          if (binding.terminalError) throw binding.terminalError.error;
          // Require each outstanding result. Do not replay the tool on a missing result.
          for (const id of binding.waiting) {
            const result = context.messages.findLast(
              (entry) => entry.role === "toolResult" && entry.toolCallId === id,
            );
            if (result?.role !== "toolResult" || !binding.bridge.accept(result))
              throw new Error("Missing ACP tool result");
          }
          binding.waiting.clear();
        }
        while (true) {
          if (binding.terminalError) throw binding.terminalError.error;
          if (binding.controller.signal.aborted) throw new Error("aborted");
          const event = binding.queue.shift();
          if (!event) {
            await new Promise<void>((resolve) => {
              binding!.wake = resolve;
            });
            binding.wake = undefined;
            continue;
          }
          if ("failed" in event) throw event.error;
          if ("done" in event) {
            if (binding.waiting.size) throw new Error("ACP ended with pending tools");
            message.stopReason = "stop";
            binding.normalCompletion = true;
            await release(binding);
            output.push({ type: "done", reason: "stop", message });
            return;
          }
          const index = message.content.length;
          if ("text" in event) {
            const content = { type: "text" as const, text: "" };
            message.content.push(content);
            output.push({ type: "text_start", contentIndex: index, partial: message });
            content.text = event.text;
            output.push({
              type: "text_delta",
              contentIndex: index,
              delta: event.text,
              partial: message,
            });
            output.push({
              type: "text_end",
              contentIndex: index,
              content: event.text,
              partial: message,
            });
          } else {
            binding.waiting.add(event.tool.id);
            message.content.push(event.tool);
            output.push({ type: "toolcall_start", contentIndex: index, partial: message });
            output.push({
              type: "toolcall_end",
              contentIndex: index,
              toolCall: event.tool,
              partial: message,
            });
            message.stopReason = "toolUse";
            output.push({ type: "done", reason: "toolUse", message });
            return;
          }
        }
      } catch (error) {
        if (binding) await release(binding, false, true).catch(() => undefined);
        fail(options.signal?.aborted === true, error);
      } finally {
        options.signal?.removeEventListener("abort", abortStream);
        streaming = false;
      }
    })();
    return output;
  }

  return {
    provider: {
      id: config.id,
      name: config.name,
      auth: config.auth,
      getModels: () => config.models,
      stream,
      streamSimple: stream,
    },
    async close() {
      disposed = true;
      if (active) await release(active);
    },
  };
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error("ACP request aborted"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
