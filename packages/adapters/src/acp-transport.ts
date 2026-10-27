import { Readable, Writable } from "node:stream";
import type { RequestPermissionResponse } from "@agentclientprotocol/sdk";
import { ClientSideConnection, ndJsonStream, RequestError } from "@agentclientprotocol/sdk";
import type { AcpSessionHost, AcpTransport } from "./acp-session.js";

type Handlers = Parameters<AcpSessionHost["connect"]>[0];
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/**
 * Use the official SDK for framing, validation and dispatch. The host supplies
 * streams from its authorized bot computer; this adapter never spawns on the API host.
 */
export class AcpStreamTransport implements AcpTransport {
  private readonly connection: ClientSideConnection;
  private readonly lifetime = new AbortController();
  private closePromise?: Promise<void>;
  private gracefulPromise?: Promise<{ clean: boolean; stopped: boolean }>;
  private gracefulFinishing = false;

  constructor(
    input: Readable,
    output: Writable,
    handlers: Handlers,
    private readonly stop: () => Promise<void>,
    private readonly timeoutMs = 120_000,
    private readonly finishProcess?: () => Promise<{ clean: boolean; stopped: boolean }>,
  ) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
      throw new Error("Invalid ACP request timeout");
    const fail = () => {
      void this.close().catch(() => undefined);
    };
    const closeOnUnexpectedStreamClose = () => {
      if (!this.gracefulFinishing) fail();
    };
    input.on("error", fail);
    output.on("error", fail);
    output.on("close", closeOnUnexpectedStreamClose);
    const stream = ndJsonStream(
      Writable.toWeb(output),
      Readable.toWeb(input) as unknown as Parameters<typeof ndJsonStream>[1],
      { maxMessageBytes: MAX_FRAME_BYTES },
    );
    this.connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async (notification) => handlers.update(notification),
        requestPermission: async (request) => {
          try {
            return (await handlers.permission(request)) as RequestPermissionResponse;
          } catch {
            return { outcome: { outcome: "cancelled" } };
          }
        },
        // Explicitly deny even if an agent ignores our advertised capabilities.
        readTextFile: async () => {
          throw RequestError.methodNotFound("fs/read_text_file");
        },
        writeTextFile: async () => {
          throw RequestError.methodNotFound("fs/write_text_file");
        },
        createTerminal: async () => {
          throw RequestError.methodNotFound("terminal/create");
        },
      }),
      stream,
    );
    void this.connection.closed
      .then(() => {
        if (!this.gracefulFinishing) return this.close();
      })
      .catch(() => {
        if (!this.gracefulFinishing) return this.close();
      })
      .catch(() => undefined);
  }

  async request(
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const scoped = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal;
    scoped.throwIfAborted();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await Promise.race([
        this.connection.request(method, params),
        new Promise<never>((_, reject) => {
          abort = () => reject(new Error("ACP request aborted"));
          scoped.addEventListener("abort", abort, { once: true });
          if (scoped.aborted) abort();
          timer = setTimeout(() => reject(new Error("ACP request timed out")), this.timeoutMs);
        }),
      ]);
    } catch {
      await this.close();
      // Raw server errors may embed credentials or tool output.
      throw new Error(scoped.aborted ? "ACP request aborted" : "ACP request failed");
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) scoped.removeEventListener("abort", abort);
    }
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    this.lifetime.signal.throwIfAborted();
    await this.connection.notify(method, params);
  }

  close(): Promise<void> {
    if (!this.closePromise) {
      this.closePromise = Promise.resolve().then(this.stop);
      this.lifetime.abort();
    }
    return this.closePromise;
  }

  finishGracefully(): Promise<{ clean: boolean; stopped: boolean }> {
    if (this.gracefulPromise) return this.gracefulPromise;
    if (this.closePromise || !this.finishProcess) {
      this.gracefulPromise = this.close().then(() => ({ clean: false, stopped: true }));
      return this.gracefulPromise;
    }
    this.gracefulFinishing = true;
    this.gracefulPromise = (async () => {
      let result: { clean: boolean; stopped: boolean };
      try {
        result = await this.finishProcess!();
      } catch (error) {
        await this.close().catch(() => undefined);
        throw error;
      }
      if (this.closePromise) return { clean: false, stopped: result.stopped };
      if (result.stopped) {
        this.closePromise = Promise.resolve();
        this.lifetime.abort();
      } else {
        await this.close();
      }
      return result;
    })();
    return this.gracefulPromise;
  }
}
