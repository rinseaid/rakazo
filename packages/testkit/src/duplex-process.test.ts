import http from "node:http";
import type { AddressInfo } from "node:net";
import { Duplex, Readable } from "node:stream";
import type Docker from "dockerode";
import { expect, it } from "vitest";
import {
  processChannel,
  processFrames,
} from "../../../infra/sandboxes/supervisor/src/process-channel.js";
import { openHttpProcess } from "../../adapters/src/duplex-process.js";

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

it("carries a bidirectional conversation over real streaming HTTP without a terminal or socket upgrade", async () => {
  const server = http.createServer((request, response) => {
    void (async () => {
      const frames = processFrames(Readable.toWeb(request) as ReadableStream<Uint8Array>);
      expect((await frames.next()).value).toMatchObject({ type: "start", argv: ["fixture"] });
      const f = fixture();
      response.writeHead(200, { "content-type": "application/x-ndjson" });
      Readable.fromWeb(processChannel(f.exec, f.stream, frames, new AbortController().signal)).pipe(
        response,
      );
    })().catch((error) => response.destroy(error));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as AddressInfo).port;
    const process = await openHttpProcess(
      `http://127.0.0.1:${port}/process`,
      {},
      { argv: ["fixture"], timeoutMs: 1000 },
      new AbortController().signal,
    );
    await process.write(new TextEncoder().encode("hello"));
    await process.end();
    await process.close();
    expect(await process.exited).toEqual({ code: 0 });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
