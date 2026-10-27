/**
 * Opt-in functional fixture: tsx scripts/check-native-acp-tools.ts /absolute/runtime [args...]
 * Uses a local deterministic Gemini gateway and an empty private HOME, never a Google account.
 * This qualifies wiring, not model quality, account authentication, or network isolation.
 * Incidental native egress is not controlled or certified by this fixture.
 * RAKAZO_FIXTURE_EAGER_MCP=1 selects supported eager schema projection.
 * RAKAZO_FIXTURE_EXPLICIT_APPROVAL=1 simulates one explicit synthetic user decision;
 * it does not qualify public provider eligibility or replace the canonical image gate.
 * Missing or unverified production gate provenance continues to deny native calls.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { copyFile, lstat, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { openAcpToolListener } from "../packages/adapters/src/acp-mcp-listener.js";
import { createAcpProcessHost } from "../packages/adapters/src/acp-process.js";
import { AcpSession } from "../packages/adapters/src/acp-session.js";
import { createAcpToolServer } from "../packages/adapters/src/acp-tool-server.js";
import {
  googleAcpCanonicalAssistantText,
  googleAcpDurableCursorHistory,
} from "../packages/adapters/src/google-acp-provider.js";
import type { HostedAcpProviderOptions } from "../packages/adapters/src/pi-acp-provider.js";
import { createHostedAcpProvider } from "../packages/adapters/src/pi-acp-provider.js";
import { PiAgentRuntime } from "../packages/adapters/src/pi-runtime.js";
import {
  nativeContextCursor,
  nativeContextDelta,
} from "../packages/db/src/native-conversation-state.js";

const NAME = "rakazo_fixture_echo_7b092d";
const DESCRIPTION = "Deterministic in-memory Rakazo native fixture 7b092d; no external effects.";
const RESULT = "rakazo-fixture-tool-result-7b092d";
const FINAL = "rakazo-fixture-final-7b092d";
const RESTORE_FINAL = "rakazo-fixture-restored-final-7b092d";
const PROMPT = `Call ${NAME} exactly once with value fixture, then return the fixture final response. Do not use other tools, files, or networks.`;
const LIMIT = 2 * 1024 * 1024;
// Supported projection metadata only: does not alter native approval or built-in policy.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: opt-in script is never run or cached by Turbo.
const eagerMcp = process.env.RAKAZO_FIXTURE_EAGER_MCP === "1";
// Synthetic explicit user decision for this deterministic fixture, NEVER an autoapproval policy.
// biome-ignore lint/suspicious/noUndeclaredEnvVars: opt-in script is never run or cached by Turbo.
const explicitApproval = process.env.RAKAZO_FIXTURE_EXPLICIT_APPROVAL === "1";
const approvalMode = explicitApproval ? "synthetic_explicit_once" : "deny";
const executable = process.argv[2];
if (!executable || !path.isAbsolute(executable)) {
  console.log(
    JSON.stringify({ status: "failed", classification: "absolute_runtime_path_required" }),
  );
  process.exit(1);
}
const counts = {
  gatewayRequests: 0,
  generations: 0,
  fixtureDeclarations: 0,
  toolGroups: 0,
  camelCaseDeclarations: 0,
  snakeCaseDeclarations: 0,
  totalDeclarations: 0,
  fixtureNameMatches: 0,
  fixtureDescriptionMatches: 0,
  mcpInitialized: 0,
  projectedFixtureTools: 0,
  toolResponses: 0,
  functionResponses: 0,
  responseSelectedNameMatches: 0,
  responseOriginalNameMatches: 0,
  responseWrapperNameMatches: 0,
  responseExactMarkerMatches: 0,
  responseStringMarkerMatches: 0,
  responseErrorMatches: 0,
  piCallbacks: 0,
  permissionRequests: 0,
  syntheticExplicitApprovals: 0,
  permissionSessionMatches: 0,
  permissionCanonicalMcpMarkers: 0,
  permissionServerMatches: 0,
  permissionToolMatches: 0,
  permissionGeneratedToolMatches: 0,
  permissionNestedFixtureArguments: 0,
  permissionSingleAllowOnce: 0,
  permissionUniqueOptions: 0,
  runtimeErrors: 0,
  restoredToolResultMatches: 0,
  restoredToolResultMarkerMatches: 0,
  restoredDispatches: 0,
  sourceDatabaseBytes: 0,
  restoredDatabaseBytes: 0,
};
let classification = "not_started";
const responseKnownKeys = new Set<string>();
let responseOtherKeyCount = 0;
let stage = "startup";
let selectedName: string | undefined;
let session: AcpSession | undefined;
let listener: Awaited<ReturnType<typeof openAcpToolListener>> | undefined;
let toolServer: ReturnType<typeof createAcpToolServer> | undefined;
let bundle: ReturnType<typeof createHostedAcpProvider> | undefined;
let restoredBundle: ReturnType<typeof createHostedAcpProvider> | undefined;
let sourceSessionId: string | undefined;
let sourceDatabase: string | undefined;
let sourceCursor: ReturnType<typeof nativeContextCursor> | undefined;
let sourceCanonicalHistory: string[] | undefined;
let sourceAssistantText = "";
let sourceFinish: { clean: boolean; stopped: boolean } | undefined;
const sourceLifecycleEvents: Array<Record<string, unknown>> = [];
let sourceListenerOpenAtFinish = false;
let sourceQuiescentFiles = false;
const restoredLifecycleEvents: Array<Record<string, unknown>> = [];
let restoredSession: AcpSession | undefined;
let restoredListener: Awaited<ReturnType<typeof openAcpToolListener>> | undefined;
let restoredToolServer: ReturnType<typeof createAcpToolServer> | undefined;
let expectedToolResultSha256: string | undefined;
let restoredToolResultSha256: string | undefined;
let restoredMarkerStringByteLengths: number[] = [];
let finalText = "";
let stopReason: string | undefined;
let cleanupPassed = true;
let passed = false;
const controller = new AbortController();
let timedOut = false;
const deadline = setTimeout(() => {
  timedOut = true;
  controller.abort();
}, 90_000);
const root = await mkdtemp(path.join(os.tmpdir(), "rakazo-native-tools-"));
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function containsExactResult(value: unknown): boolean {
  if (value === RESULT) return true;
  if (typeof value === "string") {
    try {
      return containsExactResult(JSON.parse(value));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some(containsExactResult);
  return (
    value !== null && typeof value === "object" && Object.values(value).some(containsExactResult)
  );
}
function collectResultMarkerStringBytes(value: unknown, sizes: number[] = []): number[] {
  if (typeof value === "string") {
    if (value.includes(RESULT)) sizes.push(Buffer.byteLength(value, "utf8"));
    else {
      try {
        collectResultMarkerStringBytes(JSON.parse(value), sizes);
      } catch {
        // Non-JSON text cannot contain the marker or alter fixture state.
      }
    }
    return sizes;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectResultMarkerStringBytes(item, sizes);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) collectResultMarkerStringBytes(item, sizes);
  }
  return sizes;
}
function countResultMarkerOccurrences(value: unknown): number {
  if (typeof value === "string") {
    const occurrences = value.split(RESULT).length - 1;
    if (occurrences > 0) return occurrences;
    try {
      return countResultMarkerOccurrences(JSON.parse(value));
    } catch {
      return 0;
    }
  }
  if (Array.isArray(value))
    return value.reduce((count, item) => count + countResultMarkerOccurrences(item), 0);
  if (value !== null && typeof value === "object")
    return Object.values(value).reduce(
      (count, item) => count + countResultMarkerOccurrences(item),
      0,
    );
  return 0;
}
// Inspect only structured functionResponse payloads, never assistant/user text.
function containsResultString(value: unknown): boolean {
  if (typeof value === "string") return value.includes(RESULT);
  if (Array.isArray(value)) return value.some(containsResultString);
  return (
    value !== null && typeof value === "object" && Object.values(value).some(containsResultString)
  );
}
function containsError(value: unknown, depth = 0): boolean {
  if (depth > 32) return true;
  if (typeof value === "string") {
    if (!value.startsWith("{") && !value.startsWith("[")) return false;
    try {
      return containsError(JSON.parse(value), depth + 1);
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return value.some((entry) => containsError(entry, depth + 1));
  if (value === null || typeof value !== "object") return false;
  const record = object(value);
  if (
    record.isError === true ||
    record.is_error === true ||
    (record.error !== undefined &&
      record.error !== null &&
      record.error !== false &&
      record.error !== "")
  )
    return true;
  return Object.values(record).some((entry) => containsError(entry, depth + 1));
}
const gateway = createServer((request, response) => {
  void (async () => {
    request.setTimeout(5000, () => request.destroy());
    counts.gatewayRequests++;
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const recognized =
      /^\/(v1beta|v1)\/models(?:\/[A-Za-z0-9._-]+:(streamGenerateContent|generateContent|countTokens))?$/.test(
        url.pathname,
      );
    if (!recognized || counts.gatewayRequests > 16) {
      classification = "unexpected_gateway_request";
      response.writeHead(400).end();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      size += chunk.length;
      if (size > LIMIT) {
        classification = "gateway_body_limit";
        response.writeHead(413).end();
        request.destroy();
        return;
      }
      chunks.push(chunk);
    }
    const body = object(size ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
    let output: unknown;
    if (request.method === "GET" && url.pathname.endsWith("/models")) {
      output = {
        models: [
          {
            name: "models/gemini-2.5-pro",
            displayName: "Offline fixture",
            supportedGenerationMethods: ["generateContent"],
            inputTokenLimit: 1048576,
            outputTokenLimit: 8192,
          },
        ],
      };
    } else if (request.method === "POST" && url.pathname.endsWith(":countTokens")) {
      output = { totalTokens: 10 };
    } else if (
      request.method === "POST" &&
      /:(streamGenerateContent|generateContent)$/.test(url.pathname)
    ) {
      counts.generations++;
      let parts: unknown[];
      if (counts.generations === 1) {
        const groups = list(body.tools).map(object);
        counts.toolGroups = groups.length;
        counts.camelCaseDeclarations = groups.reduce(
          (count, group) => count + list(group.functionDeclarations).length,
          0,
        );
        counts.snakeCaseDeclarations = groups.reduce(
          (count, group) => count + list(group.function_declarations).length,
          0,
        );
        const declarations = groups.flatMap((group) => [
          ...list(group.functionDeclarations),
          ...list(group.function_declarations),
        ]);
        counts.totalDeclarations = declarations.length;
        counts.fixtureNameMatches = declarations
          .map(object)
          .filter((entry) => typeof entry.name === "string" && entry.name.includes(NAME)).length;
        counts.fixtureDescriptionMatches = declarations
          .map(object)
          .filter((entry) => entry.description === DESCRIPTION).length;
        const matches = declarations
          .map(object)
          .filter(
            (entry) =>
              typeof entry.name === "string" &&
              (entry.name.includes(NAME) || entry.description === DESCRIPTION),
          );
        counts.fixtureDeclarations = matches.length;
        if (matches.length !== 1) {
          classification = "fixture_declaration_not_unique";
          response.writeHead(422).end();
          return;
        }
        selectedName = matches[0]!.name as string;
        parts = [{ functionCall: { name: selectedName, args: { value: "fixture" } } }];
      } else if (counts.generations === 2) {
        const responses = list(body.contents)
          .flatMap((content) => list(object(content).parts))
          .map((part) => object(object(part).functionResponse ?? object(part).function_response))
          .filter((entry) => Object.keys(entry).length > 0);
        counts.functionResponses = responses.length;
        counts.responseSelectedNameMatches = responses.filter(
          (entry) => entry.name === selectedName,
        ).length;
        counts.responseOriginalNameMatches = responses.filter(
          (entry) => entry.name === NAME,
        ).length;
        counts.responseWrapperNameMatches = responses.filter(
          (entry) => entry.name === "call_mcp_tool",
        ).length;
        const fixtureResponses = responses.filter(
          (entry) => entry.name === selectedName || entry.name === NAME,
        );
        for (const entry of fixtureResponses) {
          for (const key of Object.keys(object(entry.response))) {
            if (
              [
                "content",
                "result",
                "output",
                "text",
                "error",
                "isError",
                "is_error",
                "status",
                "name",
              ].includes(key)
            )
              responseKnownKeys.add(key);
            else responseOtherKeyCount++;
          }
          if (containsExactResult(entry.response)) counts.responseExactMarkerMatches++;
          if (containsResultString(entry.response)) counts.responseStringMarkerMatches++;
          if (containsError(entry.response)) counts.responseErrorMatches++;
        }
        counts.toolResponses = fixtureResponses.filter(
          (entry) => containsResultString(entry.response) && !containsError(entry.response),
        ).length;
        if (
          counts.toolResponses !== 1 ||
          counts.piCallbacks !== 1 ||
          counts.responseErrorMatches > 0
        ) {
          classification =
            counts.permissionRequests > counts.syntheticExplicitApprovals
              ? "native_permission_denied"
              : "tool_result_missing";
          response.writeHead(422).end();
          return;
        }
        parts = [{ text: FINAL }];
      } else if (counts.generations === 3) {
        const contents = list(body.contents);
        const restoredMarkerOccurrences = countResultMarkerOccurrences(contents);
        counts.restoredToolResultMarkerMatches = containsResultString(contents) ? 1 : 0;
        restoredMarkerStringByteLengths = collectResultMarkerStringBytes(contents);
        counts.restoredToolResultMatches = restoredMarkerOccurrences === 1 ? 1 : 0;
        if (restoredMarkerOccurrences === 1)
          restoredToolResultSha256 = createHash("sha256").update(RESULT).digest("hex");
        const calls = contents
          .flatMap((content) => list(object(content).parts))
          .filter(
            (part) =>
              Object.hasOwn(object(part), "functionCall") ||
              Object.hasOwn(object(part), "function_call"),
          );
        if (counts.restoredToolResultMatches !== 1 || calls.length > 1) {
          classification = "restored_tool_history_mismatch";
          response.writeHead(422).end();
          return;
        }
        parts = [{ text: RESTORE_FINAL }];
      } else {
        classification = "unexpected_generation_count";
        response.writeHead(422).end();
        return;
      }
      output = {
        candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
        modelVersion: "gemini-2.5-pro",
      };
    } else {
      classification = "unexpected_gateway_method";
      response.writeHead(400).end();
      return;
    }
    const stream = url.pathname.endsWith(":streamGenerateContent");
    const sse = stream && url.searchParams.get("alt") === "sse";
    const data = sse
      ? `data: ${JSON.stringify(output)}\n\n`
      : JSON.stringify(stream ? [output] : output);
    response
      .writeHead(200, {
        "Content-Type": sse ? "text/event-stream" : "application/json",
        "Content-Length": Buffer.byteLength(data),
        Connection: "close",
      })
      .end(data);
  })().catch(() => {
    classification = "gateway_handler_failed";
    if (!response.headersSent) response.writeHead(400);
    response.end();
  });
});
gateway.requestTimeout = 10000;
gateway.headersTimeout = 5000;
try {
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const home = path.join(root, "home");
  const cwd = path.join(root, "work");
  const gemini = path.join(root, "gemini");
  for (const directory of [home, cwd, gemini, "config", "cache", "data", "tmp"].map((entry) =>
    path.isAbsolute(entry) ? entry : path.join(root, entry),
  ))
    await mkdir(directory, { mode: 0o700 });
  await mkdir(path.join(gemini, "antigravity-acp"), { mode: 0o700 });
  await writeFile(
    path.join(gemini, "antigravity-acp", "settings.json"),
    JSON.stringify({ auth: { type: "gateway" } }),
    { mode: 0o600 },
  );
  const model: HostedAcpProviderOptions["models"][number] = {
    id: "gemini-2.5-pro",
    name: "Offline fixture",
    provider: "native-fixture",
    api: "acp",
    baseUrl: "",
    reasoning: false,
    input: ["text"],
    contextWindow: 32768,
    maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const runtime = new PiAgentRuntime({
    createProvider: (_config, scope) => {
      bundle = createHostedAcpProvider({
        id: model.provider,
        name: "Offline fixture",
        models: [model],
        auth: {
          apiKey: {
            name: "Local fixture",
            resolve: async () => ({ auth: {}, source: "offline fixture" }),
          },
        },
        open: async ({ tools, callTool, context }) => {
          const provenance = scope.request.durableNativeHistoryProvenance;
          if (!context || !provenance) throw new Error("Source cursor provenance is unavailable");
          const canonical = googleAcpDurableCursorHistory(context, provenance);
          if (!canonical) throw new Error("Source cursor history is unavailable");
          sourceCanonicalHistory = canonical.map((message) => JSON.stringify(message));
          counts.projectedFixtureTools = tools.filter((tool) => tool.name === NAME).length;
          toolServer = createAcpToolServer(tools, (name, args) => callTool(name, args), {
            maxResultEnvelopeBytes: 32 * 1024,
            onResultTooLarge: () => controller.abort(),
          });
          const server = toolServer;
          server.oninitialized = () => {
            counts.mcpInitialized++;
          };
          listener = await openAcpToolListener(server);
          const host = createAcpProcessHost({
            executable,
            args: process.argv.slice(3),
            cwd,
            home,
            requestTimeoutMs: 65000,
            terminateGraceMs: 2000,
            onLifecycleEvent: (event) => {
              sourceLifecycleEvents.push(event);
            },
            env: {
              GEMINI_HOME: gemini,
              XDG_CONFIG_HOME: path.join(root, "config"),
              XDG_CACHE_HOME: path.join(root, "cache"),
              XDG_DATA_HOME: path.join(root, "data"),
              TMPDIR: path.join(root, "tmp"),
              AGY_LLM_GATEWAY_URL: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
            },
          });
          // This simulates one explicit decision for the deterministic local fixture only.
          // Its metadata correlation is NOT safe as a policy for an untrusted model:
          // the native runtime derives some MCP metadata from argument shape.
          // This synthetic approval does not replace the canonical image-gated handoff.
          // Missing or unverified production gate provenance still fails closed.
          if (explicitApproval) {
            let decisionConsumed = false;
            host.approve = async (request, signal) => {
              if (decisionConsumed) return false;
              decisionConsumed = true;
              const meta = object(request.toolCall._meta);
              const mcp = object(meta.mcp);
              const raw = object(request.toolCall.rawInput);
              const args = object(raw.arguments);
              const exactFixture =
                eagerMcp &&
                !signal.aborted &&
                counts.permissionRequests === 1 &&
                counts.generations === 1 &&
                counts.fixtureDeclarations === 1 &&
                counts.piCallbacks === 0 &&
                counts.projectedFixtureTools === 1 &&
                counts.mcpInitialized === 1 &&
                selectedName !== undefined &&
                request.sessionId === session?.id &&
                meta.is_mcp_tool_call === true &&
                mcp.server === listener?.endpoint.name &&
                mcp.tool === NAME &&
                args.value === "fixture" &&
                Object.keys(args).length === 1 &&
                raw.value === "fixture" &&
                Object.keys(raw).every((key) => key === "arguments" || key === "value") &&
                request.options.filter((option) => option.kind === "allow_once").length === 1 &&
                new Set(request.options.map((option) => option.optionId)).size ===
                  request.options.length;
              if (exactFixture) counts.syntheticExplicitApprovals++;
              return exactFixture;
            };
          }
          // Observe requests without changing AcpSession's session/allow_once checks.
          const connect = host.connect.bind(host);
          host.connect = (handlers, signal) =>
            connect(
              {
                ...handlers,
                permission: (request) => {
                  counts.permissionRequests++;
                  const meta = object(request.toolCall._meta);
                  const mcp = object(meta.mcp);
                  const args = object(object(request.toolCall.rawInput).arguments);
                  if (request.sessionId === session?.id) counts.permissionSessionMatches++;
                  if (meta.is_mcp_tool_call === true) counts.permissionCanonicalMcpMarkers++;
                  if (mcp.server === listener?.endpoint.name) counts.permissionServerMatches++;
                  if (mcp.tool === NAME) counts.permissionToolMatches++;
                  if (mcp.tool === selectedName) counts.permissionGeneratedToolMatches++;
                  if (args.value === "fixture" && Object.keys(args).length === 1)
                    counts.permissionNestedFixtureArguments++;
                  if (request.options.filter((option) => option.kind === "allow_once").length === 1)
                    counts.permissionSingleAllowOnce++;
                  if (
                    new Set(request.options.map((option) => option.optionId)).size ===
                    request.options.length
                  )
                    counts.permissionUniqueOptions++;
                  return handlers.permission(request);
                },
              },
              signal,
            );
          session = new AcpSession(host, {
            cwd,
            modelId: model.id,
            confirmationModeId: "default",
            mcpServers: [listener.endpoint],
            creationMetadata: {
              antigravity: {
                enabledTools: [],
                mcpMaxOutputBytes: 1024 * 1024,
                ...(eagerMcp ? { eagerMcpServers: [listener.endpoint.name] } : {}),
              },
            },
          });
          return {
            close: async () => {
              stage = "normal_finish_callback_drain";
              if (stopReason === "end_turn" && session && toolServer) {
                sourceSessionId = session.id;
                toolServer.sealDispatch();
                assert.equal(await toolServer.drainCallbacks(1000), true);
                assert.equal(toolServer.callbacksSettled, true);
                sourceListenerOpenAtFinish = true;
                stage = "normal_finish_eof";
                try {
                  sourceFinish = await session.finishGracefully();
                } catch (error) {
                  const message = error instanceof Error ? error.message : "";
                  classification =
                    message === "ACP process group did not stop"
                      ? "native_process_group_did_not_stop"
                      : message === "ACP process cleanup failed"
                        ? "native_process_cleanup_failed"
                        : "native_graceful_finish_failed";
                  throw error;
                }
                assert.deepEqual(sourceFinish, { clean: true, stopped: true });
                stage = "normal_finish_snapshot_files";
                assert.ok(sourceSessionId && /^[A-Za-z0-9_-]{1,128}$/.test(sourceSessionId));
                sourceDatabase = path.join(
                  gemini,
                  "antigravity-acp",
                  "conversations",
                  `${sourceSessionId}.db`,
                );
                const db = await lstat(sourceDatabase);
                assert.ok(db.isFile() && !db.isSymbolicLink() && db.size <= 4 * 1024 * 1024);
                counts.sourceDatabaseBytes = db.size;
                const journalSizes = await Promise.all(
                  ["-wal", "-journal"].map(async (suffix) => {
                    try {
                      return (await stat(`${sourceDatabase}${suffix}`)).size;
                    } catch (error) {
                      if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
                      throw error;
                    }
                  }),
                );
                sourceQuiescentFiles = journalSizes.every((size) => size === 0);
                assert.equal(sourceQuiescentFiles, true);
                sourceCursor = nativeContextCursor([
                  ...sourceCanonicalHistory!,
                  googleAcpCanonicalAssistantText(sourceAssistantText.trim()),
                ]);
              } else {
                await session?.close();
              }
              await listener?.close();
            },
            prompt: async (_context, update, signal) => {
              stage = "session_open";
              await session!.open(signal);
              stage = "session_prompt";
              let turnText = "";
              stopReason = await session!.prompt(
                [{ type: "text", text: PROMPT }],
                (event) => {
                  const content = object(event.content);
                  if (
                    event.sessionUpdate === "agent_message_chunk" &&
                    content.type === "text" &&
                    typeof content.text === "string"
                  ) {
                    turnText += content.text;
                    update(content.text);
                  }
                },
                signal,
              );
              if (turnText.trim()) sourceAssistantText = turnText;
              assert.equal(stopReason, "end_turn");
            },
          };
        },
      });
      return bundle;
    },
  });
  classification = "native_run_failed";
  for await (const event of runtime.run(
    {
      botId: "fixture",
      threadId: "fixture",
      runId: "native-tools-fixture",
      sourceMessageId: "native-tools-source",
      durableNativeHistorySourceMessageId: "native-tools-source",
      prompt: PROMPT,
      instructions: "Use only the in-memory fixture tool.",
      history: [
        {
          id: "native-tools-source",
          role: "user",
          content: PROMPT,
        },
      ],
      model: { provider: model.provider, id: model.id },
      tools: [
        {
          name: NAME,
          description: DESCRIPTION,
          inputSchema: {
            type: "object",
            properties: { value: { type: "string" } },
            required: ["value"],
            additionalProperties: false,
          },
          readOnly: true,
        },
      ],
      executeTool: async (name, args) => {
        assert.equal(name, NAME);
        assert.deepEqual(args, { value: "fixture" });
        counts.piCallbacks++;
        assert.equal(counts.piCallbacks, 1);
        expectedToolResultSha256 = createHash("sha256").update(RESULT).digest("hex");
        return {
          kind: "agent_tool_result",
          content: [{ type: "text", text: RESULT }],
          details: {},
        };
      },
    },
    { signal: controller.signal },
  )) {
    if (event.type === "text") {
      finalText += event.text;
      assert.ok(Buffer.byteLength(finalText) < LIMIT);
    }
  }
  if (!sourceSessionId || !sourceDatabase) throw new Error("Completed source state is unavailable");
  assert.deepEqual(sourceFinish, { clean: true, stopped: true });
  assert.equal(sourceQuiescentFiles, true);
  assert.equal(sourceAssistantText.trim(), FINAL);
  assert.ok(sourceCursor);
  stage = "db_only_restore_setup";
  const restoreRoot = path.join(root, "restored-private-profile");
  const restoreHome = path.join(restoreRoot, "home");
  const restoreCwd = path.join(restoreRoot, "work");
  const restoreGemini = path.join(restoreRoot, "gemini");
  const restoreConfig = path.join(restoreRoot, "config");
  const restoreCache = path.join(restoreRoot, "cache");
  const restoreData = path.join(restoreRoot, "data");
  const restoreTmp = path.join(restoreRoot, "tmp");
  await Promise.all(
    [
      restoreHome,
      restoreCwd,
      restoreGemini,
      restoreConfig,
      restoreCache,
      restoreData,
      restoreTmp,
    ].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })),
  );
  const restoreAntigravity = path.join(restoreGemini, "antigravity-acp");
  const restoreConversations = path.join(restoreAntigravity, "conversations");
  await mkdir(restoreConversations, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(restoreAntigravity, "settings.json"),
    JSON.stringify({ auth: { type: "gateway" } }),
    { mode: 0o600 },
  );
  const restoredDatabase = path.join(restoreConversations, `${sourceSessionId}.db`);
  await copyFile(sourceDatabase, restoredDatabase);
  assert.deepEqual(await readdir(restoreConversations), [`${sourceSessionId}.db`]);
  const restoredFile = await lstat(restoredDatabase);
  assert.ok(restoredFile.isFile() && !restoredFile.isSymbolicLink());
  counts.restoredDatabaseBytes = restoredFile.size;

  restoredToolServer = createAcpToolServer(
    [
      {
        name: NAME,
        description: DESCRIPTION,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
          additionalProperties: false,
        } as Parameters<typeof createAcpToolServer>[0][number]["parameters"],
      },
    ],
    async (name) => {
      counts.restoredDispatches++;
      return {
        role: "toolResult" as const,
        toolName: name,
        toolCallId: "restored-unexpected-call",
        isError: true,
        timestamp: Date.now(),
        content: [{ type: "text" as const, text: "Restored fixture refused redispatch." }],
      };
    },
    { maxResultEnvelopeBytes: 32 * 1024 },
  );
  restoredListener = await openAcpToolListener(restoredToolServer);
  const restorePrompt = "Recall the exact previous tool result. Do not call any tools.";
  let restoredFinish: { clean: boolean; stopped: boolean } | undefined;
  let restoredStopReason: string | undefined;
  let restoredText = "";
  let restoredRuntimeText = "";
  let restoredCursorDelta: string[] | undefined;
  try {
    stage = "db_only_restore_load";
    assert.ok(sourceCursor);
    const restoredRuntime = new PiAgentRuntime({
      createProvider: (config, scope) => {
        restoredBundle = createHostedAcpProvider({
          id: config.provider,
          name: "Offline fixture restore",
          models: [model],
          auth: {
            apiKey: {
              name: "Local fixture",
              resolve: async () => ({ auth: {}, source: "offline fixture" }),
            },
          },
          open: async ({ context }) => {
            const provenance = scope.request.durableNativeHistoryProvenance;
            assert.ok(context && provenance);
            const canonical = googleAcpDurableCursorHistory(context, provenance);
            assert.ok(canonical);
            restoredCursorDelta = nativeContextDelta(
              canonical.map((message) => JSON.stringify(message)),
              sourceCursor!,
            );
            assert.ok(restoredCursorDelta);
            assert.equal(restoredCursorDelta.length, 1);
            const currentUser = [...context.messages].reverse().find((entry) => {
              if (entry.role !== "user") return false;
              const history = entry as typeof entry & { rakazoHistory?: boolean };
              return history.rakazoHistory !== true;
            });
            assert.ok(currentUser);
            const currentText =
              typeof currentUser.content === "string"
                ? currentUser.content
                : Array.isArray(currentUser.content) &&
                    currentUser.content.every((part) => part.type === "text")
                  ? currentUser.content
                      .map((part) => (part.type === "text" ? part.text : ""))
                      .join("")
                  : undefined;
            assert.equal(currentText, restorePrompt);
            const restoreHost = createAcpProcessHost({
              executable,
              args: process.argv.slice(3),
              cwd: restoreCwd,
              home: restoreHome,
              requestTimeoutMs: 65000,
              terminateGraceMs: 2000,
              onLifecycleEvent: (event) => {
                restoredLifecycleEvents.push(event);
              },
              env: {
                GEMINI_HOME: restoreGemini,
                XDG_CONFIG_HOME: restoreConfig,
                XDG_CACHE_HOME: restoreCache,
                XDG_DATA_HOME: restoreData,
                TMPDIR: restoreTmp,
                AGY_LLM_GATEWAY_URL: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
              },
            });
            restoredSession = new AcpSession(restoreHost, {
              cwd: restoreCwd,
              modelId: model.id,
              confirmationModeId: "default",
              resumeSessionId: sourceSessionId,
              mcpServers: [restoredListener!.endpoint],
              creationMetadata: {
                antigravity: {
                  enabledTools: [],
                  eagerMcpServers: [restoredListener!.endpoint.name],
                  mcpMaxOutputBytes: 1024 * 1024,
                },
              },
            });
            return {
              prompt: async (_promptContext, update, signal) => {
                await restoredSession!.open(signal);
                restoredStopReason = await restoredSession!.prompt(
                  [{ type: "text", text: currentText }],
                  (event) => {
                    const content = object(event.content);
                    if (
                      event.sessionUpdate === "agent_message_chunk" &&
                      content.type === "text" &&
                      typeof content.text === "string"
                    ) {
                      restoredText += content.text;
                      update(content.text);
                    }
                  },
                  signal,
                );
                assert.equal(restoredStopReason, "end_turn");
              },
              close: async () => {
                if (restoredStopReason === "end_turn") {
                  restoredToolServer!.sealDispatch();
                  assert.equal(await restoredToolServer!.drainCallbacks(1000), true);
                  assert.equal(restoredToolServer!.callbacksSettled, true);
                  restoredFinish = await restoredSession!.finishGracefully();
                  assert.deepEqual(restoredFinish, { clean: true, stopped: true });
                } else {
                  await restoredSession!.close();
                }
              },
            };
          },
        });
        return restoredBundle;
      },
    });
    for await (const event of restoredRuntime.run(
      {
        botId: "fixture",
        threadId: "fixture",
        runId: "native-tools-restore-fixture",
        sourceMessageId: "native-tools-restore-source",
        durableNativeHistorySourceMessageId: "native-tools-restore-source",
        historyCompactionGeneration: 0,
        prompt: restorePrompt,
        instructions: "Use only the in-memory fixture tool.",
        history: [
          { id: "native-tools-source", role: "user", content: PROMPT },
          { id: "native-tools-assistant", role: "assistant", content: sourceAssistantText.trim() },
          {
            id: "native-tools-restore-source",
            role: "user",
            content: restorePrompt,
          },
        ],
        model: { provider: model.provider, id: model.id },
        tools: [],
        executeTool: async () => {
          throw new Error("Restored fixture must not dispatch tools.");
        },
      },
      { signal: controller.signal },
    )) {
      if (event.type === "text") restoredRuntimeText += event.text;
    }
    await restoredBundle?.close();
    assert.equal(restoredStopReason, "end_turn");
    assert.equal(restoredText.trim(), RESTORE_FINAL);
    assert.equal(restoredRuntimeText.trim(), RESTORE_FINAL);
    assert.equal(restoredCursorDelta?.length, 1);
    assert.deepEqual(restoredFinish, { clean: true, stopped: true });
    assert.equal(counts.restoredDispatches, 0);
    assert.equal(counts.piCallbacks, 1);
    assert.equal(counts.permissionRequests, 1);
    const restoreJournalSizes = await Promise.all(
      ["-wal", "-journal"].map(async (suffix) => {
        try {
          return (await stat(`${restoredDatabase}${suffix}`)).size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
          throw error;
        }
      }),
    );
    assert.ok(restoreJournalSizes.every((size) => size === 0));
  } finally {
    await restoredBundle?.close();
    await restoredSession?.close();
    await restoredListener.close();
  }

  passed =
    counts.generations === 3 &&
    counts.piCallbacks === 1 &&
    counts.toolResponses === 1 &&
    counts.runtimeErrors === 0 &&
    (!explicitApproval ||
      (counts.syntheticExplicitApprovals === 1 && counts.permissionRequests === 1)) &&
    stopReason === "end_turn" &&
    finalText.trim() === FINAL &&
    counts.restoredToolResultMatches === 1 &&
    restoredToolResultSha256 === expectedToolResultSha256 &&
    counts.restoredDispatches === 0 &&
    restoredStopReason === "end_turn" &&
    restoredText.trim() === RESTORE_FINAL &&
    restoredRuntimeText.trim() === RESTORE_FINAL &&
    restoredCursorDelta?.length === 1 &&
    restoredFinish?.clean === true &&
    sourceQuiescentFiles;
  if (passed) classification = "passed";
} catch {
  counts.runtimeErrors++;
  // Never print errors or native/gateway payloads: they may contain private paths or tokens.
} finally {
  clearTimeout(deadline);
  controller.abort();
  for (const close of [
    () => bundle?.close(),
    () => restoredBundle?.close(),
    () => session?.close(),
    () => restoredSession?.close(),
    () => listener?.close(),
    () => restoredListener?.close(),
  ]) {
    try {
      await close();
    } catch {
      cleanupPassed = false;
    }
  }
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  try {
    await rm(root, { recursive: true, force: true });
  } catch {
    cleanupPassed = false;
  }
}
if (!passed && counts.permissionRequests > counts.syntheticExplicitApprovals)
  classification = "native_permission_denied";
if (!passed && timedOut) classification = "timeout";
console.log(
  JSON.stringify({
    status: passed && cleanupPassed ? "passed" : "failed",
    eagerMcp,
    approvalMode,
    automaticApprovalQualified: false,
    classification,
    stage,
    counts,
    expectedToolResultSha256,
    restoredToolResultSha256,
    restoredMarkerStringByteLengths,
    responseKnownKeys: [...responseKnownKeys].sort(),
    responseOtherKeyCount,
    finalFixtureReceived: finalText.trim() === FINAL,
    endTurn: stopReason === "end_turn",
    cleanupPassed,
    sourceFinish,
    sourceLifecycleEvents,
    sourceListenerOpenAtFinish,
    sourceDatabaseBytes: counts.sourceDatabaseBytes,
    sourceQuiescentFiles,
    restoredLifecycleEvents,
    coverage:
      "PiAgentRuntime + generic hosted provider + native ACP + scoped MCP bridge; excludes Google account auth and model quality",
  }),
);
if (!passed || !cleanupPassed) process.exitCode = 1;
