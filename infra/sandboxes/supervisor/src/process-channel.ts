import { once } from "node:events";
import type { Duplex } from "node:stream";
import { setTimeout } from "node:timers/promises";
import { createDockerStreamDemuxer } from "./supervisor-logic.js";

export const PROCESS_FRAME_BYTES = 100 * 1024;

/** A bound applies per frame, not to the lifetime of a duplex request. */
export async function* processFrames(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  let pending = Buffer.alloc(0);
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      pending = Buffer.concat([pending, value]);
      for (;;) {
        const newline = pending.indexOf(10);
        if (newline === -1) break;
        if (newline > PROCESS_FRAME_BYTES) throw new Error("Process frame is too large");
        const line = pending.subarray(0, newline);
        pending = pending.subarray(newline + 1);
        yield JSON.parse(line.toString("utf8")) as unknown;
      }
      if (pending.length > PROCESS_FRAME_BYTES) throw new Error("Process frame is too large");
    }
    if (pending.length) throw new Error("Incomplete process frame");
  } finally {
    reader.releaseLock();
  }
}

/** The packaged wrapper owns EOF/timeout cleanup; Docker exit is the confirmation. */
export function processChannel(
  exec: { inspect(): Promise<{ Running: boolean; ExitCode?: number | null }> },
  stream: Duplex,
  input: AsyncIterator<unknown>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const output = new TransformStream<Uint8Array, Uint8Array>();
  const writer = output.writable.getWriter();
  let closing = false;
  let disconnected = false;
  const stop = () => {
    if (closing) return;
    closing = true;
    // EOF is a cancellation instruction, not an unconfirmed socket destruction.
    stream.end();
  };
  // A silent child must still stop when the response reader disconnects.
  void writer.closed.catch(() => {
    disconnected = true;
    stop();
  });
  const abort = () => stop();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) stop();
  const writeOutput = async (event: object) => {
    if (disconnected) return;
    try {
      await writer.write(encoder.encode(`${JSON.stringify(event)}\n`));
    } catch {
      disconnected = true;
      stop();
    }
  };
  void (async () => {
    try {
      while (!closing) {
        const frame = await input.next();
        if (frame.done) break;
        const value = frame.value as { type?: unknown; data?: unknown };
        if (value?.type === "close") break;
        if (value?.type !== "end" && value?.type !== "stdin")
          throw new Error("Invalid process input");
        if (value.type === "stdin") {
          if (
            typeof value.data !== "string" ||
            value.data.length > 87384 ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data) ||
            Buffer.from(value.data, "base64").length > 65536
          )
            throw new Error("Invalid process input");
        }
        if (!stream.write(`${JSON.stringify(value)}\n`)) await once(stream, "drain");
      }
    } catch {
      // Malformed/disconnected input never leaves the child running.
    } finally {
      stop();
    }
  })();
  void (async () => {
    try {
      await writeOutput({ type: "ready" });
      const demux = createDockerStreamDemuxer();
      for await (const data of stream) {
        for (const piece of demux.push(Buffer.from(data)))
          if (piece.data) await writeOutput({ type: piece.stream, data: piece.data });
      }
      for (const piece of demux.finish())
        if (piece.data) await writeOutput({ type: piece.stream, data: piece.data });
      let state = await exec.inspect();
      // The attach stream can end just before Docker publishes the exit status.
      for (let attempt = 0; state.Running && attempt < 10; attempt++) {
        await setTimeout(50);
        state = await exec.inspect();
      }
      if (state.Running || state.ExitCode == null || state.ExitCode === 125)
        throw new Error("Process termination was not confirmed");
      await writeOutput({ type: "exit", code: state.ExitCode });
      await writer.close().catch(() => undefined);
    } catch {
      stop();
      await writer.abort(new Error("Process termination was not confirmed")).catch(() => undefined);
    } finally {
      signal.removeEventListener("abort", abort);
      stop();
    }
  })();
  return output.readable;
}
