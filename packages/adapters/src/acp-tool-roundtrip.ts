import { randomUUID } from "node:crypto";
import type { JsonObject, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";

interface PendingTool {
  name: string;
  resolve(result: ToolResultMessage): void;
  reject(error: Error): void;
  cleanup(): void;
}

/**
 * An ACP/MCP call is parked until Rakazo's normal Agent loop returns its result.
 * This class never executes a tool or manufactures a successful result.
 * Each instance belongs to exactly one run/account; it is not a global registry.
 */
export class AcpToolRoundtrip {
  private readonly pending = new Map<string, PendingTool>();
  private closed = false;
  private readonly tools: ReadonlySet<string>;

  constructor(
    tools: ReadonlySet<string>,
    private readonly emit: (call: ToolCall) => void,
    private readonly timeoutMs = 120_000,
    private readonly maxPending = 32,
  ) {
    this.tools = new Set(tools);
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      !Number.isSafeInteger(maxPending) ||
      maxPending <= 0
    ) {
      throw new Error("Invalid ACP tool limits");
    }
  }

  request(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<ToolResultMessage> {
    if (this.closed) return Promise.reject(new Error("ACP tool bridge closed"));
    if (!this.tools.has(name))
      return Promise.reject(new Error("Tool is not available for this run"));
    if (this.pending.size >= this.maxPending)
      return Promise.reject(new Error("ACP tool concurrency limit reached"));
    if (!args || typeof args !== "object" || Array.isArray(args))
      return Promise.reject(new Error("Invalid tool arguments"));
    signal?.throwIfAborted();
    const id = `acp_${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const abort = () => this.fail(id, "ACP tool call aborted");
      const timer = setTimeout(() => this.fail(id, "ACP tool result timed out"), this.timeoutMs);
      this.pending.set(id, {
        name,
        resolve,
        reject,
        cleanup: () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        },
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        // Clone inputs so neither agent can mutate the other side's argument object.
        this.emit({ type: "toolCall", id, name, arguments: jsonArguments(args) });
      } catch {
        this.fail(id, "ACP tool call could not be delivered");
      }
    });
  }

  /** False means stale/unrelated; never route by tool name or infer a missing id. */
  accept(result: ToolResultMessage): boolean {
    const pending = this.pending.get(result.toolCallId);
    if (!pending || this.closed) return false;
    if (pending.name !== result.toolName) {
      this.fail(result.toolCallId, "ACP tool result name mismatch");
      return false;
    }
    let copied: ToolResultMessage;
    try {
      copied = structuredClone(result);
    } catch {
      this.fail(result.toolCallId, "ACP tool result could not be serialized");
      return false;
    }
    this.pending.delete(result.toolCallId);
    pending.cleanup();
    pending.resolve(copied);
    return true;
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const id of this.pending.keys()) this.fail(id, "ACP tool bridge closed");
  }

  private fail(id: string, message: string): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup();
    pending.reject(new Error(message));
  }
}

function jsonArguments(args: Record<string, unknown>): JsonObject {
  let count = 0;
  const seen = new Set<object>();
  const check = (value: unknown, depth: number): void => {
    if (++count > 10_000 || depth > 32) throw new Error("Tool arguments exceed limits");
    if (value === null || typeof value === "string" || typeof value === "boolean") return;
    if (typeof value === "number" && Number.isFinite(value)) return;
    if (!value || typeof value !== "object" || seen.has(value))
      throw new Error("Invalid JSON tool arguments");
    if (
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null
    )
      throw new Error("Invalid JSON object");
    seen.add(value);
    for (const entry of Object.values(value)) check(entry, depth + 1);
    seen.delete(value);
  };
  check(args, 0);
  return structuredClone(args) as JsonObject;
}
