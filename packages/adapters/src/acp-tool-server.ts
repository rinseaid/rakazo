import type { Tool, ToolResultMessage } from "@earendil-works/pi-ai";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface AcpToolServer extends Server {
  reserveToolRequest(id: string | number): boolean;
  releaseUnstartedToolRequest(id: string | number): void;
  sealDispatch(): void;
  drainCallbacks(timeoutMs: number): Promise<boolean>;
  readonly callbacksSettled: boolean;
  readonly lateDispatchObserved: boolean;
}

export interface AcpToolServerOptions {
  /** Maximum UTF-8 byte length of the complete JSON-RPC tool result response. */
  maxResultEnvelopeBytes?: number;
  /** Called after an oversized result is rejected and the bridge is fenced. */
  onResultTooLarge?: () => void;
  /** Called when an ACP client attempts dispatch after end_turn sealed the bridge. */
  onLateToolDispatch?: () => void;
}

const toMcpContent = (result: ToolResultMessage) =>
  result.content.map((part) =>
    part.type === "text"
      ? { type: "text" as const, text: part.text }
      : { type: "image" as const, data: part.data, mimeType: part.mimeType },
  );

/** Measure the actual JSON-RPC response representation sent back to the ACP client. */
export function acpToolResultEnvelopeBytes(
  requestId: string | number,
  result: ToolResultMessage,
): number {
  return Buffer.byteLength(
    JSON.stringify({
      jsonrpc: "2.0",
      id: requestId,
      result: { isError: result.isError, content: toMcpContent(result) },
    }),
    "utf8",
  );
}

/**
 * MCP projection of the current run's tools. Transport/authentication are supplied
 * by the computer adapter. No global tool registry and no direct tool execution.
 */
export function createAcpToolServer(
  tools: readonly Tool[],
  callTool: (
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<ToolResultMessage>,
  options: AcpToolServerOptions = {},
): AcpToolServer {
  const names = new Set<string>();
  const active = new Map<string, { started: boolean }>();
  let dispatchSealed = false;
  let lateDispatchObserved = false;
  let activeCallbacks = 0;
  const idleWaiters = new Set<() => void>();
  let resultLimitExceeded = false;
  let notifiedResultLimit = false;
  const requestKey = (id: string | number) => `${typeof id}:${id}`;
  const definitions = tools.map((tool) => {
    if (!tool.name || names.has(tool.name)) throw new Error("Duplicate or empty ACP tool name");
    names.add(tool.name);
    const schema = JSON.parse(JSON.stringify(tool.parameters)) as Record<string, unknown>;
    if (schema.type !== "object") throw new Error("ACP tools require object argument schemas");
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: { ...schema, type: "object" as const },
    };
  });
  const server = Object.assign(
    new Server({ name: "rakazo-tools", version: "0.1.0" }, { capabilities: { tools: {} } }),
    {
      reserveToolRequest(id: string | number) {
        const key = requestKey(id);
        if (active.has(key) || active.size >= 128) return false;
        active.set(key, { started: false });
        return true;
      },
      releaseUnstartedToolRequest(id: string | number) {
        const key = requestKey(id);
        if (active.get(key)?.started === false) active.delete(key);
        if (active.size === 0 && activeCallbacks === 0) for (const wake of [...idleWaiters]) wake();
      },
      sealDispatch() {
        dispatchSealed = true;
      },
      get callbacksSettled() {
        return activeCallbacks === 0 && active.size === 0;
      },
      get lateDispatchObserved() {
        return lateDispatchObserved;
      },
      drainCallbacks(timeoutMs: number) {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0)
          return Promise.reject(new Error("Invalid ACP callback drain timeout"));
        dispatchSealed = true;
        if (activeCallbacks === 0 && active.size === 0) return Promise.resolve(true);
        return new Promise<boolean>((resolve) => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const done = () => {
            if (timer) clearTimeout(timer);
            idleWaiters.delete(done);
            resolve(activeCallbacks === 0 && active.size === 0);
          };
          idleWaiters.add(done);
          timer = setTimeout(done, timeoutMs);
        });
      },
    },
  );
  Object.defineProperties(server, {
    callbacksSettled: { get: () => activeCallbacks === 0 && active.size === 0 },
    lateDispatchObserved: { get: () => lateDispatchObserved },
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: definitions }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    if (dispatchSealed) {
      lateDispatchObserved = true;
      setImmediate(() => options.onLateToolDispatch?.());
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Native run already ended; this late tool call was not dispatched.",
          },
        ],
      };
    }
    if (resultLimitExceeded)
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: "Native run stopped after an oversized tool result; do not repeat the call.",
          },
        ],
      };
    if (!names.has(request.params.name))
      return {
        isError: true,
        content: [{ type: "text", text: "Tool is not available for this run" }],
      };
    const key = requestKey(extra.requestId);
    const reservation = active.get(key) ?? { started: false };
    if (reservation.started)
      return { isError: true, content: [{ type: "text", text: "Duplicate active tool request" }] };
    reservation.started = true;
    active.set(key, reservation);
    activeCallbacks++;
    try {
      const result = await callTool(
        request.params.name,
        request.params.arguments ?? {},
        extra.signal,
      );
      const content = toMcpContent(result);
      const response = { isError: result.isError, content };
      const maxBytes = options.maxResultEnvelopeBytes;
      if (
        maxBytes !== undefined &&
        acpToolResultEnvelopeBytes(extra.requestId, result) > maxBytes
      ) {
        resultLimitExceeded = true;
        if (!notifiedResultLimit) {
          notifiedResultLimit = true;
          // Let the MCP error response leave the listener before cancelling its ACP client.
          setImmediate(() => options.onResultTooLarge?.());
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: "Tool executed, but its result exceeded the inline output limit and was not delivered. The run is stopping; do not repeat this call. Use a narrower or paginated request.",
            },
          ],
        };
      }
      return response;
    } catch {
      // Internal error strings may contain credentials or host filesystem details.
      return { isError: true, content: [{ type: "text", text: "Tool call did not complete" }] };
    } finally {
      if (active.get(key) === reservation) active.delete(key);
      activeCallbacks--;
      if (activeCallbacks === 0 && active.size === 0) for (const wake of [...idleWaiters]) wake();
    }
  });
  return server;
}
