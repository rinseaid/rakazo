import type { CommandRequest, DuplexProcess, ProcessEvent } from "@rakazo/adapter-kit";

/** Server-only HTTP transport; each side bounds frames and honors backpressure. */
export async function openHttpProcess(
  url: string,
  headers: Record<string, string>,
  request: CommandRequest,
  signal: AbortSignal,
  options?: { onResponseHeaders?: (headers: Headers) => void },
): Promise<DuplexProcess> {
  signal.throwIfAborted();
  const input = new TransformStream<Uint8Array, Uint8Array>();
  const writer = input.writable.getWriter();
  const encoder = new TextEncoder();
  const send = (value: object) => writer.write(encoder.encode(`${JSON.stringify(value)}\n`));
  const starting = send({ type: "start", ...request });
  void starting.catch(() => undefined);
  const init = {
    method: "POST",
    headers: { ...headers, "content-type": "application/x-ndjson" },
    body: input.readable,
    duplex: "half" as const,
    signal: AbortSignal.any([signal, AbortSignal.timeout((request.timeoutMs ?? 600_000) + 15_000)]),
  };
  let response: Response | undefined;
  try {
    response = await fetch(url, init);
    if (!response.ok || !response.body)
      throw new Error(`Process connection failed (${response.status})`);
    options?.onResponseHeaders?.(new Headers(response.headers));
    await starting;
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined);
    await writer.abort(error).catch(() => undefined);
    throw error;
  }
  const reader = response.body.getReader();
  let ended = false;
  let closing: Promise<void> | undefined;
  let finished = false;
  let failure: unknown;
  let pendingBytes = 0;
  let outputBytes = 0;
  const queue: ProcessEvent[] = [];
  let wake: (() => void) | undefined;
  let discard = false;
  let settle!: (value: { code: number }) => void;
  let fail!: (error: unknown) => void;
  const exited = new Promise<{ code: number }>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  void exited.catch(() => undefined);
  const close = (): Promise<void> => {
    closing ??= (async () => {
      discard = true;
      queue.length = 0;
      outputBytes = 0;
      if (!finished) await send({ type: "close" }).catch(() => undefined);
      await exited;
    })();
    return closing;
  };
  const abort = () => {
    void close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  void (async () => {
    let buffer = "";
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
          const newline = buffer.indexOf("\n");
          if (newline === -1) break;
          if (newline > 1024 * 1024) throw new Error("Process output frame is too large");
          const parsed = JSON.parse(buffer.slice(0, newline)) as { type?: unknown };
          const event = parsed as ProcessEvent;
          buffer = buffer.slice(newline + 1);
          if (parsed.type === "ready") continue;
          if (event.type === "exit" && Number.isSafeInteger(event.code)) {
            finished = true;
            if (!discard) queue.push(event);
            settle({ code: event.code });
            return;
          }
          if (
            (event.type !== "stdout" && event.type !== "stderr") ||
            typeof event.data !== "string"
          )
            throw new Error("Invalid process output");
          if (!discard) {
            outputBytes += encoder.encode(event.data).length;
            if (outputBytes > 4 * 1024 * 1024)
              throw new Error("Process output consumer is too slow");
            queue.push(event);
            wake?.();
          }
        }
        if (buffer.length > 1024 * 1024) throw new Error("Process output frame is too large");
      }
      throw new Error("Process termination was not confirmed");
    } catch (error) {
      failure = error;
      finished = true;
      fail(error);
    } finally {
      signal.removeEventListener("abort", abort);
      wake?.();
      // EOF makes the supervisor cancel even when parsing/consumption failed.
      void writer.close().catch(() => undefined);
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  })();
  return {
    exited,
    close,
    async write(data) {
      signal.throwIfAborted();
      if (ended || closing || finished) throw new Error("Process stdin is closed");
      if (data.byteLength > 65536 || pendingBytes + data.byteLength > 256 * 1024)
        throw new Error("Process input exceeds its bound");
      pendingBytes += data.byteLength;
      try {
        await send({ type: "stdin", data: Buffer.from(data).toString("base64") });
      } finally {
        pendingBytes -= data.byteLength;
      }
    },
    async end() {
      if (ended) return;
      ended = true;
      if (!closing && !finished) await send({ type: "end" });
    },
    events: {
      async *[Symbol.asyncIterator]() {
        try {
          for (;;) {
            const event = queue.shift();
            if (event) {
              if (event.type !== "exit") outputBytes -= encoder.encode(event.data).length;
              yield event;
            } else if (finished) {
              if (failure) throw failure;
              return;
            } else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        } finally {
          await close();
        }
      },
    },
  };
}
