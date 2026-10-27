import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { AcpToolServer } from "./acp-tool-server.js";

/** Loopback-only tool endpoint in the same isolated computer as the ACP process. */
export async function openAcpToolListener(server: AcpToolServer): Promise<{
  endpoint: {
    name: string;
    type: "http";
    url: string;
    headers: Array<{ name: string; value: string }>;
  };
  close(): Promise<void>;
}> {
  const token = randomBytes(32).toString("base64url");
  const expected = Buffer.from(`Bearer ${token}`);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    enableJsonResponse: true,
  });
  await server.connect(transport);
  let origin = "";
  const http = createServer((request, response) => {
    void (async () => {
      const supplied = Buffer.from(request.headers.authorization ?? "");
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        response.writeHead(401);
        response.end();
        return;
      }
      if (
        request.url !== "/mcp" ||
        request.headers.host !== new URL(origin).host ||
        (request.headers.origin && request.headers.origin !== origin)
      ) {
        response.writeHead(403);
        response.end();
        return;
      }
      if (request.method !== "POST") {
        response.writeHead(405);
        response.end();
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          response.writeHead(413);
          response.end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400);
        response.end();
        return;
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        response.writeHead(400);
        response.end();
        return;
      }
      const message = body as { method?: unknown; id?: unknown };
      const toolId =
        message.method === "tools/call" &&
        (typeof message.id === "string" ||
          (typeof message.id === "number" && Number.isFinite(message.id)))
          ? message.id
          : undefined;
      if (toolId !== undefined && !server.reserveToolRequest(toolId)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: toolId,
            error: { code: -32600, message: "Duplicate active tool request or concurrency limit" },
          }),
        );
        return;
      }
      try {
        await transport.handleRequest(request, response, body);
      } finally {
        if (toolId !== undefined) server.releaseUnstartedToolRequest(toolId);
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  http.requestTimeout = 15000;
  http.headersTimeout = 10000;
  try {
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
  } catch {
    await server.close();
    throw new Error("ACP tool listener could not start");
  }
  origin = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  let closing: Promise<void> | undefined;
  return {
    endpoint: {
      name: "rakazo",
      type: "http",
      url: `${origin}/mcp`,
      headers: [{ name: "Authorization", value: `Bearer ${token}` }],
    },
    close() {
      closing ??= (async () => {
        await server.close();
        http.closeAllConnections();
        await new Promise<void>((resolve) => http.close(() => resolve()));
      })();
      return closing;
    },
  };
}
