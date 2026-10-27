import { afterEach, describe, expect, it, vi } from "vitest";
import { openHttpProcess } from "./duplex-process.js";

const encoder = new TextEncoder();
afterEach(() => vi.unstubAllGlobals());

function server(
  onFrame: (frame: any, output: ReadableStreamDefaultController<Uint8Array>) => void,
) {
  const frames: any[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      const reader = init.body.getReader();
      let output!: ReadableStreamDefaultController<Uint8Array>;
      const response = new Response(
        new ReadableStream<Uint8Array>({
          start(c) {
            output = c;
          },
        }),
      );
      void (async () => {
        const decoder = new TextDecoder();
        let pending = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          pending += decoder.decode(value);
          for (;;) {
            const newline = pending.indexOf("\n");
            if (newline === -1) break;
            const frame = JSON.parse(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            frames.push(frame);
            onFrame(frame, output);
          }
        }
      })().catch(() => undefined);
      return response;
    }),
  );
  return frames;
}
const emit = (c: ReadableStreamDefaultController<Uint8Array>, event: object) =>
  c.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));

describe("duplex process", () => {
  it("writes binary stdin, independently ends stdin, and retains separated output and confirmed exit", async () => {
    const frames = server((frame, c) => {
      if (frame.type === "start") emit(c, { type: "ready" });
      if (frame.type === "stdin") {
        emit(c, { type: "stdout", data: "out" });
        emit(c, { type: "stderr", data: "err" });
      }
      if (frame.type === "end") {
        emit(c, { type: "exit", code: 7 });
        c.close();
      }
    });
    const process = await openHttpProcess(
      "https://example.invalid/process",
      {},
      { argv: ["fixture"] },
      new AbortController().signal,
    );
    const output = (async () => {
      const events = [];
      for await (const event of process.events) events.push(event);
      return events;
    })();
    await process.write(new Uint8Array([0, 255]));
    await process.end();
    expect(await process.exited).toEqual({ code: 7 });
    expect(await output).toEqual([
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 7 },
    ]);
    expect(frames[1]).toEqual({ type: "stdin", data: "AP8=" });
    await process.close();
  });
  it("cancels on abort and closes idempotently while awaiting exit", async () => {
    const frames = server((frame, c) => {
      if (frame.type === "close") {
        emit(c, { type: "exit", code: 0 });
        c.close();
      }
    });
    const controller = new AbortController();
    const process = await openHttpProcess(
      "https://example.invalid/process",
      {},
      { argv: ["fixture"] },
      controller.signal,
    );
    controller.abort();
    const first = process.close();
    expect(process.close()).toBe(first);
    await first;
    expect(frames.filter((frame) => frame.type === "close")).toHaveLength(1);
  });
  it("cancels the initial supervisor handshake when the owning request aborts", async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn((_url, init) => {
        requestSignal = init.signal!;
        return new Promise<Response>((_resolve, reject) => {
          requestSignal!.addEventListener("abort", () => reject(requestSignal!.reason), {
            once: true,
          });
        });
      }),
    );
    const pending = openHttpProcess(
      "https://example.invalid/process",
      {},
      { argv: ["fixture"], timeoutMs: 1 },
      controller.signal,
    );
    expect(requestSignal).toBeDefined();
    controller.abort(new Error("owner canceled"));
    await expect(pending).rejects.toThrow("owner canceled");
    expect(requestSignal?.aborted).toBe(true);
  });
  it("refuses oversized input and reports lost termination evidence", async () => {
    let output!: ReadableStreamDefaultController<Uint8Array>;
    server((_frame, c) => {
      output = c;
    });
    const process = await openHttpProcess(
      "https://example.invalid/process",
      {},
      { argv: ["fixture"] },
      new AbortController().signal,
    );
    await expect(process.write(new Uint8Array(65537))).rejects.toThrow("bound");
    output.close();
    await expect(process.exited).rejects.toThrow("not confirmed");
    await expect(process.close()).rejects.toThrow("not confirmed");
  });
});
