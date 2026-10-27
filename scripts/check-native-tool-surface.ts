/**
 * Opt-in declaration inventory for an already verified native runtime.
 * Run: tsx scripts/check-native-tool-surface.ts /absolute/runtime [runtime args...]
 * Synthetic loopback gateway only; no account, model tool calls, or approvals.
 * This records exposed declarations, NOT proof of inaccessible native executors.
 * Native incidental egress and OS containment are not certified by this fixture.
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { openAcpToolListener } from "../packages/adapters/src/acp-mcp-listener.js";
import { createAcpProcessHost } from "../packages/adapters/src/acp-process.js";
import { AcpSession } from "../packages/adapters/src/acp-session.js";
import { createAcpToolServer } from "../packages/adapters/src/acp-tool-server.js";

const NAME = "rakazo_surface_fixture_7b092d";
const FINAL = "rakazo-surface-inventory-finished";
const executable = process.argv[2];
const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const safeName = (value: unknown): string => {
  if (typeof value !== "string" || !/^[A-Za-z0-9_.:-]{1,160}$/.test(value))
    throw new Error("invalid declaration identifier");
  return value;
};
// Schema values/descriptions/defaults are never emitted. Only fixed type labels/counts.
function schemaCategories(value: unknown, depth = 0): string[] {
  if (depth > 12) return ["depth_limit"];
  if (Array.isArray(value))
    return [...new Set(value.flatMap((item) => schemaCategories(item, depth + 1)))].sort();
  if (value === null || typeof value !== "object") return [];
  const entry = record(value);
  const types = new Set<string>();
  for (const item of Array.isArray(entry.type) ? entry.type : [entry.type]) {
    if (
      typeof item === "string" &&
      /^(object|array|string|number|integer|boolean|null)$/i.test(item)
    )
      types.add(item.toLowerCase());
  }
  for (const key of ["properties", "items", "allOf", "anyOf", "oneOf", "$defs", "definitions"]) {
    const child = entry[key];
    const children =
      key === "properties" || key === "$defs" || key === "definitions"
        ? Object.values(record(child))
        : [child];
    for (const item of children)
      for (const type of schemaCategories(item, depth + 1)) types.add(type);
  }
  return [...types].sort();
}
const counts = { requests: 0, generations: 0, permissionRequests: 0, unexpectedMcpCalls: 0 };
let inventory: Array<{ name: string; schemaCategories: string[] }> = [];
// Only these two observed native declarations receive descriptive inspection.
// No model/user text, schema values/defaults, headers, or other tool descriptions.
let resourceDeclarations: Array<{
  name: string;
  description: string;
  properties: Array<{ name: string; schemaCategories: string[] }>;
  required: string[];
}> = [];
let classification = "not_started";
let cleanupPassed = true;
let passed = false;
let session: AcpSession | undefined;
let listener: Awaited<ReturnType<typeof openAcpToolListener>> | undefined;
let root: string | undefined;
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 90_000);
const gateway = createServer((request, response) => {
  void (async () => {
    request.setTimeout(5000, () => request.destroy());
    if (++counts.requests > 16) throw new Error("request count bound");
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      !/^\/(v1beta|v1)\/models(?:\/[A-Za-z0-9._-]+:(streamGenerateContent|generateContent|countTokens))?$/.test(
        url.pathname,
      )
    )
      throw new Error("unexpected request");
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("body bound");
      chunks.push(chunk);
    }
    const body = record(bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
    let result: unknown;
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      result = {
        models: [
          {
            name: "models/gemini-2.5-pro",
            displayName: "Synthetic fixture",
            supportedGenerationMethods: ["generateContent"],
            inputTokenLimit: 1048576,
            outputTokenLimit: 8192,
          },
        ],
      };
    } else if (request.method === "POST" && url.pathname.endsWith(":countTokens")) {
      result = { totalTokens: 10 };
    } else if (
      request.method === "POST" &&
      /:(streamGenerateContent|generateContent)$/.test(url.pathname)
    ) {
      assert.equal(++counts.generations, 1);
      const declarations = list(body.tools).flatMap((group) => [
        ...list(record(group).functionDeclarations),
        ...list(record(group).function_declarations),
      ]);
      assert.ok(declarations.length > 0 && declarations.length <= 128);
      resourceDeclarations = declarations
        .map(record)
        .filter((entry) => entry.name === "list_resources" || entry.name === "read_resource")
        .map((entry) => {
          const schema = record(
            entry.parameters ?? entry.parametersJsonSchema ?? entry.parameters_json_schema,
          );
          const description = typeof entry.description === "string" ? entry.description : "";
          assert.ok(
            description.length <= 2048 &&
              Array.from(description).every(
                (character) => character.charCodeAt(0) >= 32 || "\t\r\n".includes(character),
              ),
          );
          const properties = Object.entries(record(schema.properties));
          const required = list(schema.required);
          assert.ok(properties.length <= 16 && required.length <= 16);
          return {
            name: safeName(entry.name),
            description,
            properties: properties
              .map(([name, value]) => ({
                name: safeName(name),
                schemaCategories: schemaCategories(value),
              }))
              .sort((a, b) => a.name.localeCompare(b.name)),
            required: required.map(safeName).sort(),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      inventory = declarations
        .map((item) => {
          const entry = record(item);
          return {
            name: safeName(entry.name),
            schemaCategories: schemaCategories(
              entry.parameters ?? entry.parametersJsonSchema ?? entry.parameters_json_schema,
            ),
          };
        })
        .sort((a, b) => a.name.localeCompare(b.name));
      assert.equal(inventory.filter((item) => item.name.includes(NAME)).length, 1);
      result = {
        candidates: [
          { content: { role: "model", parts: [{ text: FINAL }] }, finishReason: "STOP", index: 0 },
        ],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
        modelVersion: "gemini-2.5-pro",
      };
    } else throw new Error("unexpected method");
    const stream = url.pathname.endsWith(":streamGenerateContent");
    const sse = stream && url.searchParams.get("alt") === "sse";
    const data = sse
      ? `data: ${JSON.stringify(result)}\n\n`
      : JSON.stringify(stream ? [result] : result);
    response
      .writeHead(200, {
        "Content-Type": sse ? "text/event-stream" : "application/json",
        "Content-Length": Buffer.byteLength(data),
        Connection: "close",
      })
      .end(data);
  })().catch(() => {
    classification = "gateway_validation_failed";
    if (!response.headersSent) response.writeHead(400);
    response.end();
    controller.abort();
  });
});
gateway.requestTimeout = 10000;
gateway.headersTimeout = 5000;
try {
  assert.ok(executable && path.isAbsolute(executable));
  root = await mkdtemp(path.join(os.tmpdir(), "rakazo-tool-surface-"));
  const dirs = Object.fromEntries(
    ["home", "work", "gemini", "config", "cache", "data", "tmp"].map((name) => [
      name,
      path.join(root!, name),
    ]),
  );
  for (const directory of Object.values(dirs)) await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(dirs.gemini!, "antigravity-acp"), { mode: 0o700 });
  await writeFile(
    path.join(dirs.gemini!, "antigravity-acp", "settings.json"),
    JSON.stringify({ auth: { type: "gateway" } }),
    { mode: 0o600 },
  );
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  listener = await openAcpToolListener(
    createAcpToolServer(
      [
        {
          name: NAME,
          description: "Synthetic in-memory inventory fixture; never invoked.",
          parameters: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
          },
        },
      ],
      async () => {
        counts.unexpectedMcpCalls++;
        throw new Error("inventory fixture never executes tools");
      },
    ),
  );
  const host = createAcpProcessHost({
    executable,
    args: process.argv.slice(3),
    cwd: dirs.work!,
    home: dirs.home!,
    requestTimeoutMs: 65000,
    terminateGraceMs: 2000,
    env: {
      GEMINI_HOME: dirs.gemini!,
      XDG_CONFIG_HOME: dirs.config!,
      XDG_CACHE_HOME: dirs.cache!,
      XDG_DATA_HOME: dirs.data!,
      TMPDIR: dirs.tmp!,
      AGY_LLM_GATEWAY_URL: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
    },
  });
  // Observe and deny every request; no allow callback exists.
  const connect = host.connect.bind(host);
  host.connect = (handlers, signal) =>
    connect(
      {
        ...handlers,
        permission: (request) => {
          counts.permissionRequests++;
          return handlers.permission(request);
        },
      },
      signal,
    );
  session = new AcpSession(host, {
    cwd: dirs.work!,
    modelId: "gemini-2.5-pro",
    confirmationModeId: "default",
    mcpServers: [listener.endpoint],
    creationMetadata: {
      antigravity: { enabledTools: [], eagerMcpServers: [listener.endpoint.name] },
    },
  });
  await session.open(controller.signal);
  let text = "";
  const stop = await session.prompt(
    [{ type: "text", text: "Return the synthetic final response. Do not call tools." }],
    (event) => {
      if (event.sessionUpdate === "agent_message_chunk" && record(event.content).type === "text")
        text += String(record(event.content).text ?? "");
    },
    controller.signal,
  );
  assert.equal(stop, "end_turn");
  assert.equal(text, FINAL);
  assert.equal(counts.permissionRequests, 0);
  assert.equal(counts.unexpectedMcpCalls, 0);
  classification = "declaration_inventory_only";
  passed = true;
} catch {
  if (classification === "not_started")
    classification = controller.signal.aborted ? "timed_out_or_cancelled" : "fixture_failed";
} finally {
  clearTimeout(deadline);
  try {
    await session?.close();
  } catch {
    cleanupPassed = false;
  }
  try {
    await listener?.close();
  } catch {
    cleanupPassed = false;
  }
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  if (root && cleanupPassed) await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    status: passed && cleanupPassed ? "passed" : "failed",
    classification,
    scope: "synthetic_local_gateway_declarations_not_execution_enforcement_or_personal_oauth",
    approvalMode: "deny_all",
    counts,
    inventory,
    resourceDeclarations,
    cleanupPassed,
  }),
);
process.exitCode = passed && cleanupPassed ? 0 : 1;
