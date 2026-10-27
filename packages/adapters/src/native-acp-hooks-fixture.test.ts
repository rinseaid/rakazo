import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import {
  CASES,
  expectedEffects,
  fixtureServer,
  hookConfiguration,
  hookProgram,
  OTHER,
  RESERVED,
  RESOURCE,
  targetFor,
} from "./native-acp-hooks-fixture.js";
import { resultEnvelopePayload } from "./native-acp-result-fixture.js";

async function runHook(test: Parameters<typeof hookProgram>[0], name: string) {
  const observed: unknown[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      let input = "";
      for await (const chunk of req) input += chunk;
      observed.push(JSON.parse(input));
      res.writeHead(200).end();
    })();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const child = spawn(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        hookProgram(
          test,
          `http://127.0.0.1:${(server.address() as AddressInfo).port}/fixture-hook`,
        ),
      ],
      { stdio: ["pipe", "pipe", "pipe"], env: {} },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.resume();
    const done = once(child, "close");
    child.stdin.end(JSON.stringify({ toolCall: { name, args: { value: "fixture" } } }));
    const [code] = await done;
    return { stdout, code, observed };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("ordinary ACP hook fixture", () => {
  it("counts only in-memory MCP calls and resources", async () => {
    const counts = { dispatches: 0, effects: 0, resourceLists: 0, resourceReads: 0 };
    const server = fixtureServer(counts);
    const client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      expect((await client.listTools()).tools.map((t) => t.name)).toEqual([RESERVED, OTHER]);
      expect(counts.effects).toBe(0);
      expect(
        (await client.callTool({ name: RESERVED, arguments: { value: "fixture" } })).isError,
      ).toBe(false);
      expect(counts.dispatches).toBe(1);
      expect(counts.effects).toBe(1);
      expect((await client.listResources()).resources[0]?.uri).toBe(RESOURCE);
      expect((await client.readResource({ uri: RESOURCE })).contents).toHaveLength(1);
      expect(counts.resourceLists).toBe(1);
      expect(counts.resourceReads).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("preserves synthetic Pi denial after bridge dispatch", async () => {
    const counts = { dispatches: 0, effects: 0, resourceLists: 0, resourceReads: 0 };
    const server = fixtureServer(counts, () => false);
    const client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    try {
      expect(
        (await client.callTool({ name: RESERVED, arguments: { value: "fixture" } })).isError,
      ).toBe(true);
      expect(counts.dispatches).toBe(1);
      expect(counts.effects).toBe(0);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("sizes escaped output using the real MCP request id", async () => {
    const counts = { dispatches: 0, effects: 0, resourceLists: 0, resourceReads: 0 };
    let expected: ReturnType<typeof resultEnvelopePayload> | undefined;
    const server = fixtureServer(
      counts,
      () => true,
      undefined,
      (id) => {
        expected = resultEnvelopePayload(id);
        return expected.text;
      },
    );
    const client = new Client({ name: "fixture", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(a);
    await client.connect(b);
    let measured = 0;
    const send = a.send.bind(a);
    a.send = async (message) => {
      if (
        expected &&
        "id" in message &&
        message.id === expected.envelope.id &&
        "result" in message
      ) {
        expect(message).toEqual(expected.envelope);
        measured = Buffer.byteLength(JSON.stringify(message));
      }
      return send(message);
    };
    try {
      const result = await client.callTool({ name: RESERVED, arguments: { value: "fixture" } });
      expect(result.isError).toBe(false);
      expect(measured).toBe(32768);
      expect(counts.effects).toBe(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
  it("uses supported enabled wildcard PreToolUse configuration", () => {
    expect(hookConfiguration("fixture-command")).toEqual({
      "fixture-gate": {
        enabled: true,
        PreToolUse: [
          { matcher: "*", hooks: [{ type: "command", command: "fixture-command", timeout: 5 }] },
        ],
      },
    });
  });
  it("has a closed case registry with the expected positive-effect cases", () => {
    expect(CASES.filter((c) => expectedEffects(c))).toEqual([
      "fixed-result-inline-envelope-32k",
      "fixed-result-inline-graceful-restore",
      "fixed-result-inline-32k",
      "fixed-result-inline-unicode-16k",
      "fixed-result-inline-unicode-32k",
      "fixed-result-inline-16k",
      "fixed-result-inline-128k",
      "fixed-result-inline-512k",
      "fixed-result-inline-restore",
      "fixed-result-16k",
      "fixed-result-128k",
      "fixed-result-512k",
      "fixed-result-restore",
      "fixed-load-allow",
      "fixed-allow",
      "baseline",
      "allow",
    ]);
    expect(targetFor("other")).toBe(OTHER);
    expect(targetFor("list_resources")).toBe("list_resources");
    expect(targetFor("read_resource")).toBe("read_resource");
  });
  it("allows exactly the reserved canonical name", async () => {
    const result = await runHook("allow", RESERVED);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).allowTool).toBe(true);
    expect(result.observed).toEqual([{ name: RESERVED }]);
  });
  it.each([OTHER, "list_resources", "read_resource"])(
    "denies harmless nonallowlisted name %s",
    async (name) => {
      const result = await runHook("allow", name);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).allowTool).toBe(false);
    },
  );
  it("can explicitly deny the reserved tool", async () => {
    expect(JSON.parse((await runHook("deny", RESERVED)).stdout).allowTool).toBe(false);
  });
  it("produces deliberate nonzero and malformed-output fixture cases", async () => {
    expect((await runHook("nonzero", RESERVED)).code).toBe(1);
    const result = await runHook("malformed", RESERVED);
    expect(result.code).toBe(0);
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});
