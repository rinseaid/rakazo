import { Duplex } from "node:stream";
import type Docker from "dockerode";
import { describe, expect, it } from "vitest";
import { processChannel, processFrames } from "./process-channel.js";

const encoder = new TextEncoder();
function body(...chunks: string[]) {
  return new ReadableStream<Uint8Array>({
    start(c) {
      for (const chunk of chunks) c.enqueue(encoder.encode(chunk));
      c.close();
    },
  });
}
async function collect<T>(items: AsyncIterable<T>) {
  const result = [];
  for await (const item of items) result.push(item);
  return result;
}
function packet(channel: number, data: string) {
  const bytes = Buffer.from(data);
  const header = Buffer.alloc(8);
  header[0] = channel;
  header.writeUInt32BE(bytes.length, 4);
  return Buffer.concat([header, bytes]);
}
function fixture(code = 0) {
  const written: string[] = [];
  const stream = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      written.push(String(chunk));
      callback();
    },
    final(callback) {
      this.push(packet(1, "out"));
      this.push(packet(2, "err"));
      this.push(null);
      callback();
    },
  });
  const exec = {
    inspect: async () => ({ Running: false, ExitCode: code }),
  } as unknown as Docker.Exec;
  return { stream, exec, written };
}

describe("supervisor process channel", () => {
  it("frames split requests and rejects oversized or incomplete frames", async () => {
    expect(await collect(processFrames(body('{"type":', '"end"}\n')))).toEqual([{ type: "end" }]);
    await expect(collect(processFrames(body("x".repeat(102401))))).rejects.toThrow("too large");
    await expect(collect(processFrames(body("{}")))).rejects.toThrow("Incomplete");
  });
  it("streams ready and separated output, forwards stdin, and confirms exit", async () => {
    const f = fixture(7);
    const input = processFrames(
      body('{"type":"stdin","data":"eA=="}\n{"type":"end"}\n{"type":"close"}\n'),
    );
    const response = new Response(
      processChannel(f.exec, f.stream, input, new AbortController().signal),
    );
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual([
      { type: "ready" },
      { type: "stdout", data: "out" },
      { type: "stderr", data: "err" },
      { type: "exit", code: 7 },
    ]);
    expect(f.written).toEqual(['{"type":"stdin","data":"eA=="}\n', '{"type":"end"}\n']);
  });
  it("rejects helper cleanup failure rather than inventing a confirmed exit", async () => {
    const f = fixture(125);
    const response = new Response(
      processChannel(
        f.exec,
        f.stream,
        processFrames(body('{"type":"close"}\n')),
        new AbortController().signal,
      ),
    );
    await expect(response.text()).rejects.toThrow("not confirmed");
  });
  it("stops a silent child when the output consumer disconnects", async () => {
    const f = fixture();
    const input = { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
    const reader = processChannel(
      f.exec,
      f.stream,
      input,
      new AbortController().signal,
    ).getReader();
    await reader.read(); // ready, while the child has not produced any output
    await reader.cancel();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(f.stream.writableEnded).toBe(true);
  });

  it("cancels a live process on request disconnect", async () => {
    const f = fixture();
    const controller = new AbortController();
    const input = { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
    const response = new Response(processChannel(f.exec, f.stream, input, controller.signal));
    controller.abort();
    expect(await response.text()).toContain('"type":"exit"');
    expect(f.stream.writableEnded).toBe(true);
  });
});
