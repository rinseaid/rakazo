/**
 * Opt-in ORDINARY functional fixture, never a production approval policy.
 * tsx scripts/check-native-acp-hooks.ts CASE /absolute/runtime [runtime args...]
 * Fresh private profiles, deterministic loopback backend, in-memory MCP only.
 * One explicit synthetic approval is pre-authorized by invoking a case; no account.
 * Does not certify incidental native egress, sandbox containment or real-model behavior.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { openAcpToolListener } from "../packages/adapters/src/acp-mcp-listener.js";
import { createAcpProcessHost } from "../packages/adapters/src/acp-process.js";
import { AcpSession } from "../packages/adapters/src/acp-session.js";
import { GOOGLE_ACP_GATE_SCRIPT } from "../packages/adapters/src/google-acp-tool-gate.js";
import { createGracefulFixtureHost } from "../packages/adapters/src/native-acp-graceful-fixture.js";
import type { HookCase } from "../packages/adapters/src/native-acp-hooks-fixture.js";
import {
  CASES,
  expectedEffects,
  fixtureServer,
  hookConfiguration,
  hookProgram,
  RESOURCE,
  targetFor,
} from "../packages/adapters/src/native-acp-hooks-fixture.js";
import {
  inspectResultResponses,
  resultEnvelopePayload,
  resultPayload,
} from "../packages/adapters/src/native-acp-result-fixture.js";

const test = process.argv[2] as HookCase;
const executable = process.argv[3];
assert.ok(
  CASES.includes(test) && executable && path.isAbsolute(executable),
  "CASE and absolute runtime path required",
);
const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const FINAL = "fixture-final";
let resultText = test.startsWith("fixed-result-")
  ? resultPayload(
      test.endsWith("-512k")
        ? 512 * 1024
        : test.endsWith("-128k")
          ? 128 * 1024
          : test.endsWith("-32k")
            ? 32 * 1024
            : 16 * 1024,
      test.includes("-unicode-"),
    )
  : undefined;
const inlineResultLimit = test.startsWith("fixed-result-inline-") ? 1024 * 1024 : undefined;
const completedToolRestore =
  test === "fixed-result-restore" ||
  test === "fixed-result-inline-restore" ||
  test === "fixed-result-inline-graceful-restore";
let resultEvidence: ReturnType<typeof inspectResultResponses> | undefined;
let restoredResultEvidence: ReturnType<typeof inspectResultResponses> | undefined;
let textOnlyRestored = false;
const envelopeCase = test === "fixed-result-inline-envelope-32k";
let envelopeRequestId: string | number | undefined;
let envelopeEvidence:
  | {
      preparedBytes: number;
      actualTransportBytes: number;
      exactEnvelopeMatches: number;
      rawTextBytes: number;
    }
  | undefined;
const gracefulClose = test === "fixed-result-inline-graceful-restore";
const gracefulDrivers: ReturnType<typeof createGracefulFixtureHost>[] = [];
let finishNormally: (() => Promise<void>) | undefined;
const counts = {
  restoreWalBytes: 0,
  restoreJournalBytes: 0,
  restoreDbBytes: 0,
  restoredProfiles: 0,
  preludeGenerations: 0,
  declarations: 0,
  declarationMatches: 0,
  requests: 0,
  generations: 0,
  permissions: 0,
  explicitApprovals: 0,
  dispatches: 0,
  effects: 0,
  resourceLists: 0,
  resourceReads: 0,
  hookCalls: 0,
  canonicalMatches: 0,
  functionResponses: 0,
};
let root: string | undefined;
let session: AcpSession | undefined;
let listener: Awaited<ReturnType<typeof openAcpToolListener>> | undefined;
let passed = false;
let cleanupPassed = true;
let classification = "fixture_failed";
let phase = "startup";
let prelude = test.startsWith("fixed-load-");
let selectedName = "";
let resourceBaseline = { lists: 0, reads: 0 };
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 90_000);
const gateway = createServer((request, response) => {
  void (async () => {
    request.setTimeout(5000, () => request.destroy());
    if (++counts.requests > 20) throw new Error("request bound");
    let bytes = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 2 * 1024 * 1024) throw new Error("body bound");
      chunks.push(chunk);
    }
    const body = record(bytes ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/fixture-hook" && request.method === "POST") {
      counts.hookCalls++;
      if (body.name === targetFor(test)) counts.canonicalMatches++;
      response.writeHead(200).end();
      return;
    }
    assert.match(
      url.pathname,
      /^\/(v1beta|v1)\/models(?:\/[A-Za-z0-9._-]+:(streamGenerateContent|generateContent|countTokens))?$/,
    );
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
    } else {
      assert.equal(request.method, "POST");
      assert.match(url.pathname, /:(streamGenerateContent|generateContent)$/);
      counts.generations++;
      let parts: unknown[];
      if (textOnlyRestored) {
        assert.equal(counts.generations, 1);
        restoredResultEvidence = inspectResultResponses(body.contents, resultText!);
        parts = [{ text: FINAL }];
      } else if (prelude) {
        counts.preludeGenerations++;
        assert.equal(counts.preludeGenerations, 1);
        parts = [{ text: FINAL }];
      } else if (counts.generations === 1) {
        const declarations = list(body.tools)
          .flatMap((group) => [
            ...list(record(group).functionDeclarations),
            ...list(record(group).function_declarations),
          ])
          .map(record);
        const target = targetFor(test);
        const matches = declarations.filter(
          (d) =>
            typeof d.name === "string" &&
            (d.name === target || d.name === `mcp_${listener!.endpoint.name}_${target}`),
        );
        counts.declarations = declarations.length;
        counts.declarationMatches = matches.length;
        phase = "declaration_selection";
        assert.equal(matches.length, 1);
        selectedName = matches[0]!.name as string;
        // Strict observed surface: no native calls except harmless resource helpers.
        assert.ok(declarations.every((d) => typeof d.name === "string"));
        resourceBaseline = { lists: counts.resourceLists, reads: counts.resourceReads };
        let args: Record<string, unknown> = { value: "fixture" };
        if (test === "list_resources" || test === "read_resource") {
          const schema = record(
            matches[0]!.parameters ??
              matches[0]!.parametersJsonSchema ??
              matches[0]!.parameters_json_schema,
          );
          const properties = record(schema.properties);
          args = {};
          for (const key of Object.keys(properties)) {
            if (/^(server|server_name|ServerName)$/.test(key)) args[key] = listener!.endpoint.name;
            else if (/^(uri|Uri|URI|resource_uri)$/.test(key) && test === "read_resource")
              args[key] = RESOURCE;
            else if (key === "toolAction") args[key] = "Inspect synthetic in-memory resource";
            else if (key === "toolSummary") args[key] = "Ordinary resource fixture";
            else if (list(schema.required).includes(key))
              throw new Error("unsupported resource schema");
          }
        }
        phase = "tool_requested";
        parts = [{ functionCall: { name: selectedName, args } }];
      } else {
        assert.equal(counts.generations, 2);
        counts.functionResponses = list(body.contents)
          .flatMap((c) => list(record(c).parts))
          .filter(
            (p) =>
              Object.keys(record(record(p).functionResponse ?? record(p).function_response))
                .length > 0,
          ).length;
        assert.ok(counts.functionResponses >= 1);
        if (resultText) resultEvidence = inspectResultResponses(body.contents, resultText);
        parts = [{ text: FINAL }];
      }
      output = {
        candidates: [{ content: { role: "model", parts }, finishReason: "STOP", index: 0 }],
        usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 3, totalTokenCount: 13 },
        modelVersion: "gemini-2.5-pro",
      };
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
    classification = "gateway_or_observer_validation_failed";
    if (!response.headersSent) response.writeHead(400);
    response.end();
    controller.abort();
  });
});
gateway.requestTimeout = 10000;
gateway.headersTimeout = 5000;
try {
  root = await mkdtemp(path.join(os.tmpdir(), "rakazo-hook-fixture-"));
  const dirs = Object.fromEntries(
    ["home", "work", "gemini", "config", "cache", "data", "tmp"].map((n) => [
      n,
      path.join(root!, n),
    ]),
  );
  for (const dir of Object.values(dirs)) await mkdir(dir, { mode: 0o700 });
  await mkdir(path.join(dirs.gemini!, "antigravity-acp"), { mode: 0o700 });
  await mkdir(path.join(dirs.gemini!, "config"), { mode: 0o700 });
  await writeFile(
    path.join(dirs.gemini!, "antigravity-acp", "settings.json"),
    JSON.stringify({ auth: { type: "gateway" } }),
    { mode: 0o600 },
  );
  gateway.listen(0, "127.0.0.1");
  await once(gateway, "listening");
  const origin = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  if (test !== "baseline") {
    const script = path.join(root, "trusted-hook.mjs");
    const config = path.join(dirs.gemini!, "config", "hooks.json");
    const fixedProgramPath = path.join(root, "fixed-program.mjs");
    if (test.startsWith("fixed-"))
      await writeFile(fixedProgramPath, GOOGLE_ACP_GATE_SCRIPT, { mode: 0o400 });
    const source = hookProgram(test, `${origin}/fixture-hook`, fixedProgramPath);
    // ACP uses shlex.split + exec, not a shell. Quote both absolute paths.
    const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
    const settings = hookConfiguration(`${quote(process.execPath)} ${quote(script)}`);
    await writeFile(script, source, { mode: 0o400 });
    await writeFile(config, JSON.stringify(settings), { mode: 0o400 });
    assert.deepEqual(JSON.parse(await readFile(config, "utf8")), settings);
    const digest = (s: string) => createHash("sha256").update(s).digest("hex");
    assert.equal(digest(await readFile(script, "utf8")), digest(source));
  }
  const fixtureMcpServer = fixtureServer(
    counts,
    () => test !== "pi-deny" && test !== "fixed-pi-deny" && test !== "fixed-load-pi-deny",
    resultText,
    envelopeCase
      ? (requestId) => {
          const generated = resultEnvelopePayload(requestId);
          envelopeRequestId = requestId;
          resultText = generated.text;
          envelopeEvidence = {
            preparedBytes: generated.serializedBytes,
            actualTransportBytes: 0,
            exactEnvelopeMatches: 0,
            rawTextBytes: Buffer.byteLength(generated.text),
          };
          return generated.text;
        }
      : undefined,
  );
  listener = await openAcpToolListener(fixtureMcpServer);
  if (envelopeCase) {
    const transport = fixtureMcpServer.transport!;
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if ("id" in message && message.id === envelopeRequestId && "result" in message) {
        assert.ok(envelopeEvidence);
        envelopeEvidence.actualTransportBytes = Buffer.byteLength(JSON.stringify(message));
        const expected = resultEnvelopePayload(envelopeRequestId!);
        assert.deepEqual(message, expected.envelope);
        assert.equal(envelopeEvidence.actualTransportBytes, 32 * 1024);
        envelopeEvidence.exactEnvelopeMatches++;
      }
      return send(message, options);
    };
  }
  const makeSession = (resumeSessionId?: string) => {
    const hostOptions = {
      executable,
      args: process.argv.slice(4),
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
        AGY_LLM_GATEWAY_URL: origin,
      },
    };
    const driver = gracefulClose ? createGracefulFixtureHost(hostOptions) : undefined;
    if (driver) gracefulDrivers.push(driver);
    finishNormally = driver?.finishNormally;
    const host = driver?.host ?? createAcpProcessHost(hostOptions);

    // One PRE-AUTHORIZED synthetic decision. No metadata is treated as tool identity.
    // This decision is fixture-only and does not authorize production.
    // Production uses image-gated canonical tool handoff; a missing or unverified gate denies.
    host.approve = async (request, signal) => {
      counts.permissions++;
      const allow =
        !signal.aborted &&
        counts.permissions === 1 &&
        phase === "tool_requested" &&
        counts.generations === 1 &&
        counts.dispatches === 0 &&
        request.sessionId === session?.id &&
        request.options.filter((o) => o.kind === "allow_once").length === 1;
      if (allow) counts.explicitApprovals++;
      return allow;
    };
    return new AcpSession(host, {
      resumeSessionId,
      cwd: dirs.work!,
      modelId: "gemini-2.5-pro",
      confirmationModeId: "default",
      mcpServers: [listener!.endpoint],
      creationMetadata: {
        antigravity: {
          enabledTools: [],
          eagerMcpServers: [listener!.endpoint.name],
          ...(inlineResultLimit ? { mcpMaxOutputBytes: inlineResultLimit } : {}),
        },
      },
    });
  };
  const restoreProfile = async () => {
    classification = "completed_tool_restore_failed";
    phase = "restore_close";
    const savedId = session!.id!;
    const previousEndpoint = listener!.endpoint.url;
    if (finishNormally) await finishNormally();
    await session!.close();
    await listener!.close();
    phase = "restore_quiescence";
    // DB only after clean shutdown; no cached grants or metadata sidecars copied.
    for (const suffix of ["-wal", "-journal"]) {
      const size = await lstat(
        path.join(dirs.gemini!, "antigravity-acp", "conversations", `${savedId}.db${suffix}`),
      )
        .then((stat) => stat.size)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return 0;
          throw error;
        });
      if (suffix === "-wal") counts.restoreWalBytes = size;
      else counts.restoreJournalBytes = size;
      assert.equal(size, 0, "Native DB must be quiescent");
    }
    phase = "restore_db_read";
    const database = await readFile(
      path.join(dirs.gemini!, "antigravity-acp", "conversations", `${savedId}.db`),
    );
    counts.restoreDbBytes = database.length;
    assert.ok(database.length > 0 && database.length <= 2 * 1024 * 1024);
    phase = "restore_profile_materialize";
    const hookConfig = await readFile(path.join(dirs.gemini!, "config", "hooks.json"));
    for (const key of Object.keys(dirs)) {
      dirs[key] = path.join(root!, `restored-${key}`);
      await mkdir(dirs[key]!, { mode: 0o700 });
    }
    await mkdir(path.join(dirs.gemini!, "antigravity-acp", "conversations"), {
      recursive: true,
      mode: 0o700,
    });
    await mkdir(path.join(dirs.gemini!, "config"), { mode: 0o700 });
    await writeFile(
      path.join(dirs.gemini!, "antigravity-acp", "settings.json"),
      JSON.stringify({ auth: { type: "gateway" } }),
      { mode: 0o600 },
    );
    await writeFile(path.join(dirs.gemini!, "config", "hooks.json"), hookConfig, { mode: 0o400 });
    await writeFile(
      path.join(dirs.gemini!, "antigravity-acp", "conversations", `${savedId}.db`),
      database,
      { mode: 0o600 },
    );
    listener = await openAcpToolListener(
      fixtureServer(counts, () => test !== "fixed-load-pi-deny", resultText),
    );
    assert.notEqual(listener!.endpoint.url, previousEndpoint);
    counts.restoredProfiles++;
    counts.generations = 0;
    prelude = false;
    phase = "restore_open";
    session = makeSession(savedId);
    await session.open(controller.signal);
  };
  session = makeSession();
  await session.open(controller.signal);
  if (prelude) {
    phase = "prelude";
    const firstStop = await session.prompt(
      [{ type: "text", text: "Return the synthetic final response without tools." }],
      () => {},
      controller.signal,
    );
    assert.equal(firstStop, "end_turn");
    await restoreProfile();
  }
  let text = "";
  const stop = await session.prompt(
    [
      {
        type: "text",
        text: "Perform the single synthetic in-memory fixture call, then finish. No other tools.",
      },
    ],
    (event) => {
      if (event.sessionUpdate === "agent_message_chunk" && record(event.content).type === "text")
        text += String(record(event.content).text ?? "");
      assert.ok(text.length < 4096);
    },
    controller.signal,
  );
  phase = "completed";
  assert.equal(stop, "end_turn");
  assert.equal(text.trim(), FINAL);
  assert.equal(counts.generations, 2);
  assert.equal(
    counts.dispatches,
    test === "pi-deny" || test === "fixed-pi-deny" || test === "fixed-load-pi-deny"
      ? 1
      : expectedEffects(test),
  );
  assert.equal(counts.effects, expectedEffects(test));
  assert.equal(counts.resourceReads - resourceBaseline.reads, 0);
  assert.equal(counts.resourceLists - resourceBaseline.lists, 0);
  assert.equal(counts.hookCalls, test === "baseline" ? 0 : 1);
  assert.equal(counts.canonicalMatches, test === "baseline" ? 0 : 1);
  assert.equal(counts.permissions, counts.explicitApprovals);
  if (
    expectedEffects(test) ||
    test === "pi-deny" ||
    test === "fixed-pi-deny" ||
    test === "fixed-load-pi-deny"
  )
    assert.equal(counts.explicitApprovals, 1);
  if (resultText) {
    classification = "tool_result_not_preserved";
    assert.ok(
      resultEvidence &&
        resultEvidence.completeMatches > 0 &&
        resultEvidence.begin &&
        resultEvidence.middle &&
        resultEvidence.end,
    );
  }
  if (envelopeCase) {
    assert.ok(envelopeEvidence);
    assert.equal(envelopeEvidence.exactEnvelopeMatches, 1);
    assert.equal(envelopeEvidence.actualTransportBytes, 32 * 1024);
  }
  if (completedToolRestore) {
    textOnlyRestored = true;
    await restoreProfile();
    const restoredStop = await session!.prompt(
      [{ type: "text", text: "Return the synthetic final response. Do not call tools." }],
      () => {},
      controller.signal,
    );
    assert.equal(restoredStop, "end_turn");
    if (finishNormally) await finishNormally();
    assert.equal(counts.generations, 1);
    assert.equal(counts.dispatches, 1);
    assert.equal(counts.effects, 1);
    assert.equal(counts.permissions, 1);
    assert.equal(counts.hookCalls, 1);
    classification = "restored_tool_result_not_preserved";
    assert.ok(restoredResultEvidence && restoredResultEvidence.completeMatches > 0);
    phase = "restored_completed_tool_history_verified";
  }
  passed = true;
  classification = "bounded_functional_conformance";
} catch {
  if (controller.signal.aborted && classification === "fixture_failed")
    classification = "timeout_or_cancelled";
} finally {
  clearTimeout(deadline);
  controller.abort();
  for (const close of [() => session?.close(), () => listener?.close()]) {
    try {
      await close();
    } catch {
      cleanupPassed = false;
    }
  }
  gateway.closeAllConnections();
  await new Promise<void>((resolve) => gateway.close(() => resolve()));
  if (root && cleanupPassed) await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify({
    status: passed && cleanupPassed ? "passed" : "failed",
    test,
    classification,
    phase,
    counts,
    resourceBaseline,
    resultEvidence,
    gracefulCloseEvidence: gracefulDrivers.map((driver) => driver.evidence),
    restoredResultEvidence,
    envelopeEvidence,
    cleanupPassed,
    automaticApprovalQualified: false,
    fixedPathImageQualified: false,
    identicalProductionProgram: test.startsWith("fixed-"),
    completedToolRestoreFixture: completedToolRestore,
    inlineResultLimit: inlineResultLimit ?? null,
    pendingToolRestoreQualified: false,
    scope: "ordinary_synthetic_fixture_only_not_production_or_security_certification",
  }),
);
process.exitCode = passed && cleanupPassed ? 0 : 1;
