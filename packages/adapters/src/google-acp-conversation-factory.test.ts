import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import type { AssistantMessage, TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, normalizeContext, Type } from "@earendil-works/pi-ai";
import type {
  AgentRunModel,
  AgentRunRequest,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { promoteNativeConversationCandidate } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { AccountOperationProcess } from "./account-operation-host.js";
import type { AcpConversationState } from "./acp-conversation.js";
import { serveHostedRunRelay } from "./acp-run-relay.js";
import {
  GOOGLE_ACP_EXPERIMENTAL_INPUT_BYTES,
  googleAcpContextHistory,
  googleAcpModel,
  prepareGoogleAcpInput,
} from "./google-acp-provider.js";
import { createAccountModelProvider } from "./google-acp-remote.js";
import {
  bindNativeConversationCandidate,
  emitNativeConversationCandidate,
  forwardNativeConversationCandidateSink,
  type NativeConversationRunCandidate,
  registerNativeConversationCandidateSink,
} from "./native-conversation-candidate.js";
import type { PiAgentRuntimeOptions } from "./pi-runtime.js";
import { PiAgentRuntime } from "./pi-runtime.js";

const boundary = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./account-operation-host.js", () => ({ openAccountOperationProcess: boundary.open }));

function fixture() {
  let row: Record<string, any> | undefined;
  let secretId = "loaded-generation";
  let historyGeneration = 0;
  let stopped = false;
  let parked: (() => void) | undefined;
  let performTool = false;
  let chunks = ["fixture answer"];
  let snapshotBytes: Buffer = Buffer.from("sensitive-native-state");
  let runtimeIdentity: string | undefined = `docker-image:sha256:${"a".repeat(64)}`;
  const hosts = new Set<string>();
  const received: Array<{
    initialized?: boolean;
    restore?: AcpConversationState;
    context?: TranscriptContext;
  }> = [];
  const serves: Promise<void>[] = [];
  const lock = vi.fn(async () => ({ count: 1 }));
  const put = vi.fn(async ({ where, data }) => {
    if (
      !row ||
      row.revision !== where.revision ||
      row.claimHostId !== where.claimHostId ||
      row.ciphertext !== null
    )
      return { count: 0 };
    Object.assign(row, data);
    return { count: 1 };
  });
  const key = { id: "fixture-key", spaceId: "space", version: 1, key: new Uint8Array(32).fill(5) };
  const prisma = {
    $contentEncryption: () => ({
      ring: { encryptWrites: false, current: async () => key, byId: async () => key },
    }),
    $transaction: async (action: (tx: unknown) => Promise<unknown>) => {
      const previous = row ? { ...row } : undefined;
      try {
        return await action(prisma);
      } catch (error) {
        row = previous;
        throw error;
      }
    },
    run: { updateMany: lock },
    accountOperationHost: {
      updateMany: vi.fn(async ({ where }) => ({ count: hosts.has(where.id) ? 1 : 0 })),
      findFirst: async ({ where }: { where: { id: string } }) =>
        hosts.has(where.id) ? { id: where.id } : null,
    },
    userModelCredential: {
      findFirst: vi.fn(async ({ where }) =>
        !where.secretId || where.secretId === secretId ? { id: "connection" } : null,
      ),
      updateMany: vi.fn(async ({ where }) => ({ count: where.secretId === secretId ? 1 : 0 })),
    },
    thread: {
      findFirst: vi.fn(async ({ where }) =>
        where.historyCompactionGeneration === historyGeneration ? { id: where.id } : null,
      ),
      updateMany: vi.fn(async ({ where }) => ({
        count: where.historyCompactionGeneration === historyGeneration ? 1 : 0,
      })),
    },
    nativeConversationState: {
      upsert: vi.fn(async ({ create }) => {
        row = row
          ? { ...row, revision: row.revision + 1 }
          : { ...create, ciphertext: null, claimHostId: null };
        return { ...row };
      }),
      update: async ({ data }: { data: Record<string, unknown> }) => Object.assign(row!, data),
      updateMany: put,
    },
  };
  const config: AgentRunModel = {
    provider: "google-antigravity",
    id: "fixture-model",
    connectionId: "connection",
    nativeAuth: {
      provider: "google-antigravity",
      accountGeneration: secretId,
      persist: async () => true,
      profile: {
        version: 1,
        files: [
          {
            path: ".gemini/antigravity-acp/settings.json",
            data: '{"auth":{"type":"oauth-personal"}}',
          },
          {
            path: ".gemini/antigravity-acp/acp_token.json",
            data: JSON.stringify({
              refresh_token: "fixture",
              client_id: "fixture",
              client_secret: "fixture",
              token_uri: "https://oauth2.googleapis.com/token",
            }),
          },
        ],
      },
    },
  };
  const scope: Parameters<NonNullable<PiAgentRuntimeOptions["createProvider"]>>[1] = {
    context: { userId: "user", spaceId: "space", runLease: { owner: "worker", fence: 1 } },
    agentNamespace: "main",
    signal: new AbortController().signal,
    request: {
      runId: "run",
      threadId: "thread",
      botId: "bot",
      historyCompactionGeneration: 0,
    } as AgentRunRequest,
  };
  boundary.open.mockImplementation(async (_deps, hostInput) => {
    const id = `host-${received.length}`;
    hosts.add(id);
    const record: (typeof received)[number] = {};
    received.push(record);
    const input = new PassThrough();
    const output = new PassThrough();
    const serve = serveHostedRunRelay({
      input,
      output,
      createRun: async ({ conversation, callTool }) => {
        record.initialized = true;
        record.restore = conversation?.restore;
        let completed = false;
        return {
          prompt: async (context, text, signal) => {
            record.context = context;
            if (parked) {
              const started = parked;
              parked = undefined;
              await new Promise<never>((_resolve, reject) => {
                const abort = () => reject(new Error("fixture cancelled prompt"));
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
                started();
              });
            }
            if (stopped) throw new Error("fixture unknown outcome");
            if (performTool) {
              await callTool("fixture_tool", {});
            }
            for (const chunk of chunks) text(chunk);
            completed = true;
          },
          close: async () => {
            if (completed)
              await conversation?.offerCandidate({
                version: 1,
                sessionId: "fixture-session",
                data: snapshotBytes.toString("base64"),
              });
          },
        };
      },
    });
    void serve.catch(() => {});
    serves.push(serve);
    const process: AccountOperationProcess = {
      runtimeIdentity,
      lease: {
        id,
        userId: "user",
        spaceId: "space",
        operationId: hostInput.operationId,
        expiresAt: new Date(Date.now() + 60000),
      },
      events: (async function* (): AsyncGenerator<ProcessEvent> {
        for await (const data of output) yield { type: "stdout", data: data.toString() };
      })(),
      exited: new Promise(() => {}),
      write: async (data) => {
        input.write(data);
      },
      end: async () => {
        input.end();
      },
      close: async () => {
        hosts.delete(id);
        input.destroy();
        output.destroy();
      },
    };
    return process;
  });
  const factory = createAccountModelProvider({
    prisma: prisma as unknown as PrismaClient,
    sandbox: {
      describe: () => ({ id: "private-fixture", contractVersion: "1", adapterVersion: "1" }),
    } as SandboxProvider,
  });
  function setProvenance(prompt: string, sourceMessageId: string) {
    const logical = createHash("sha256").update(prompt).digest("hex");
    scope.request.durableNativeHistoryProvenance = {
      sourceMessageId,
      logicalContentSha256: logical,
      deliveredPromptSha256: logical,
    };
  }
  async function turn(context: TranscriptContext, signal?: AbortSignal) {
    const userMessages = context.messages.filter((message) => message.role === "user");
    const current = userMessages.at(-1);
    if (current && typeof current.content === "string") {
      const sourceMessageId = `fixture-source-${context.messages.indexOf(current)}`;
      setProvenance(current.content, sourceMessageId);
      context = {
        ...context,
        messages: context.messages.map((message, index) =>
          message.role === "user" && message !== current
            ? {
                ...message,
                rakazoHistory: true,
                rakazoHistoryRole: "user",
                rakazoMessageId: `fixture-source-${index}`,
              }
            : message,
        ) as TranscriptContext["messages"],
      };
    }
    let candidate: NativeConversationRunCandidate | undefined;
    registerNativeConversationCandidateSink(scope.request, (next) => {
      if (candidate) candidate = undefined;
      else candidate = next;
    });
    const adapter = factory(config, scope)!;
    const result = await adapter.provider
      .streamSimple(googleAcpModel(config), context, { signal })
      .result();
    await adapter.close();
    await Promise.allSettled(serves);
    const text = result.content
      .filter((part) => part.type === "text")
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    if (candidate && result.stopReason === "stop" && text.trim())
      await promoteCandidate(
        candidate,
        [text],
        scope.request.runId,
        scope.context!.runLease!.owner,
        scope.context!.runLease!.fence,
      );
    return result;
  }
  async function promoteCandidate(
    candidate: NativeConversationRunCandidate,
    assistantHistory: readonly string[],
    runId: string,
    leaseOwner: string,
    leaseFence: number,
  ) {
    const run = await prisma.run.updateMany();
    if (run.count !== 1) return false;
    const token = bindNativeConversationCandidate(candidate, assistantHistory);
    await promoteNativeConversationCandidate(prisma as unknown as Prisma.TransactionClient, token, {
      runId,
      leaseOwner,
      leaseFence,
      userId: "user",
    });
  }
  function captureRuntime(runtime: PiAgentRuntime) {
    return {
      describe: () => runtime.describe(),
      abort: (runId: string) => runtime.abort(runId),
      run(request: AgentRunRequest, context?: Parameters<PiAgentRuntime["run"]>[1]) {
        let candidate: NativeConversationRunCandidate | undefined;
        let ambiguous = false;
        registerNativeConversationCandidateSink(request, (next) => {
          if (candidate || ambiguous) {
            candidate = undefined;
            ambiguous = true;
          } else candidate = next;
        });
        return (async function* () {
          let text = "";
          for await (const event of runtime.run(request, context)) {
            if (event.type === "text") text += event.text;
            yield event;
          }
          if (candidate && !ambiguous && text.trim()) {
            const lease = context?.runLease;
            if (lease)
              await promoteCandidate(candidate, [text], request.runId, lease.owner, lease.fence);
          }
        })();
      },
    };
  }
  return {
    config,
    scope,
    prisma,
    put,
    received,
    turn,
    factory,
    row: () => row,
    hostCount: () => hosts.size,
    setSnapshotBytes: (bytes: Buffer) => {
      snapshotBytes = bytes;
    },
    setChunks: (value: string[]) => {
      chunks = value;
    },
    setRuntimeIdentity: (value: string | undefined) => {
      runtimeIdentity = value;
    },
    setSecret: (value: string) => {
      secretId = value;
    },
    setGeneration: (value: number) => {
      historyGeneration = value;
      scope.request.historyCompactionGeneration = value;
    },
    failPrompt: () => {
      stopped = true;
    },
    parkPrompt: () =>
      new Promise<void>((resolve) => {
        parked = resolve;
      }),
    recoverPrompt: () => {
      stopped = false;
    },
    enableTools: () => {
      performTool = true;
    },
    setProvenance,
    captureRuntime,
  };
}
const firstContext = () =>
  normalizeContext({
    systemPrompt: "fixture instructions",
    messages: [{ role: "user", content: "first question", timestamp: 0 }],
  });
const nextContext = (first: TranscriptContext, answer: AssistantMessage) =>
  normalizeContext({
    messages: [
      ...first.messages,
      answer,
      { role: "user", content: "second question", timestamp: 1 },
    ],
  });

describe("private native conversation factory composition", () => {
  it("discards candidates without an accepting sink or with ineligible provenance", () => {
    const makeCandidate = () => {
      const candidate = {
        pending: { discard: vi.fn() },
      } as unknown as NativeConversationRunCandidate;
      return candidate;
    };
    const orphan = makeCandidate();
    emitNativeConversationCandidate({}, orphan);
    expect(orphan.pending.discard).toHaveBeenCalledOnce();

    const source = {};
    const target = {};
    const forwarded = makeCandidate();
    registerNativeConversationCandidateSink(source, vi.fn());
    forwardNativeConversationCandidateSink(source, target, () => false);
    emitNativeConversationCandidate(target, forwarded);
    expect(forwarded.pending.discard).toHaveBeenCalledOnce();
  });

  it("never guesses an assistant history role from a user's literal prefix", () => {
    const context = normalizeContext({
      messages: [{ role: "user", content: "Assistant: fixture answer", timestamp: 0 }],
    });
    expect(googleAcpContextHistory(context)).toEqual([
      { role: "user", content: "Assistant: fixture answer" },
    ]);
  });
  it("restores across real PiAgentRuntime persisted-history reconstruction and multiple text chunks", async () => {
    const f = fixture();
    f.setChunks(["fixture ", "answer"]);
    const runtime = f.captureRuntime(new PiAgentRuntime({ createProvider: f.factory }));
    const firstPrompt = "first question\n\nCurrent time: 2030-01-01T00:00:00Z";
    const secondPrompt = "second question\n\nCurrent time: 2030-01-01T00:01:00Z";
    const rawFirst = "first question; literal user text: Current time: 1999-12-31T23:59:59Z";
    const request: AgentRunRequest = {
      ...f.scope.request,
      sourceMessageId: "first-user",
      durableNativeHistorySourceMessageId: "first-user",
      model: f.config,
      prompt: firstPrompt,
      instructions: "fixture instructions",
      history: [{ role: "user", id: "first-user", content: rawFirst }],
      tools: [],
      contextStrategy: "current",
    };
    const events = [];
    for await (const event of runtime.run(request, f.scope.context)) events.push(event);
    const answer = events
      .filter((event) => event.type === "text")
      .map((event) => (event.type === "text" ? event.text : ""))
      .join("");
    expect(answer).toBe("fixture answer");
    expect(f.row()?.ciphertext).toMatch(/^rkz1:/);
    for await (const _event of runtime.run(
      {
        ...request,
        runId: "next-run",
        sourceMessageId: "second-user",
        durableNativeHistorySourceMessageId: "second-user",
        prompt: secondPrompt,
        history: [
          { role: "user", content: rawFirst, id: "first-user" },
          { role: "assistant", content: answer, id: "first-answer" },
          { role: "user", content: "second question", id: "second-user" },
        ],
      },
      { ...f.scope.context, runLease: { owner: "worker", fence: 2 } },
    )) {
      /* drain */
    }
    expect(f.received).toHaveLength(2);
    expect(f.received[1]?.restore?.sessionId).toBe("fixture-session");
    expect(googleAcpContextHistory(f.received[1]!.context!)).toEqual([
      { role: "user", content: secondPrompt },
    ]);
    expect(googleAcpContextHistory(f.received[0]!.context!)).toEqual([
      { role: "user", content: firstPrompt },
    ]);
    expect(f.put).toHaveBeenCalledTimes(2);
  });
  it("restores four cumulative 64KiB turns through real Pi runtime history reconstruction", async () => {
    const f = fixture();
    const runtime = f.captureRuntime(new PiAgentRuntime({ createProvider: f.factory }));
    const history: NonNullable<AgentRunRequest["history"]> = [];
    for (let i = 0; i < 4; i++) {
      const prompt = `${i}:${"x".repeat(64 * 1024)}`;
      let answer = "";
      for await (const event of runtime.run(
        {
          ...f.scope.request,
          sourceMessageId: `u${i}`,
          durableNativeHistorySourceMessageId: `u${i}`,
          runId: `large-turn-${i}`,
          model: f.config,
          prompt,
          instructions: "fixture instructions",
          history: [...history, { role: "user", id: `u${i}`, content: prompt }],
          tools: [],
          contextStrategy: "current",
        },
        { ...f.scope.context, runLease: { owner: "worker", fence: i + 1 } },
      )) {
        if (event.type === "text") answer += event.text;
      }
      expect(answer).toBe("fixture answer");
      expect(Boolean(f.received[i]?.restore)).toBe(i > 0);
      expect(googleAcpContextHistory(f.received[i]!.context!)).toEqual([
        { role: "user", content: prompt },
      ]);
      history.push(
        { role: "user", content: prompt, id: `u${i}` },
        { role: "assistant", content: answer, id: `a${i}` },
      );
    }
    expect(Buffer.byteLength(JSON.stringify(history))).toBeGreaterThan(256 * 1024);
    expect(f.put).toHaveBeenCalledTimes(4);
    expect(f.hostCount()).toBe(0);
  });
  it("restores a completed native tool turn through the real Pi loop without replay", async () => {
    const f = fixture();
    f.enableTools();
    f.setChunks(["Answer ", "after ", "the effect."]);
    const runtime = f.captureRuntime(new PiAgentRuntime({ createProvider: f.factory }));
    const source = "tool-loop-source-1";
    const raw = "perform the approved fixture action";
    const prompt = `${raw}\n\nCurrent time: 2030-05-01T00:00:00Z`;
    const executeTool = vi.fn(async () => ({ content: "synthetic effect result" }));
    const base: AgentRunRequest = {
      ...f.scope.request,
      sourceMessageId: source,
      durableNativeHistorySourceMessageId: source,
      model: f.config,
      prompt,
      instructions: "fixture instructions",
      history: [{ role: "user", id: source, content: raw }],
      tools: [
        {
          name: "fixture_tool",
          description: "Synthetic fixture action",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      executeTool,
      contextStrategy: "current",
    };
    let firstAnswer = "";
    for await (const event of runtime.run(
      { ...base, runId: "native-tool-loop-1" },
      { ...f.scope.context, runLease: { owner: "worker", fence: 1 } },
    ))
      if (event.type === "text") firstAnswer += event.text;

    expect(firstAnswer).toBe("Answer after the effect.");
    expect(executeTool).toHaveBeenCalledOnce();
    expect(f.row()?.ciphertext).toMatch(/^rkz1:/);

    const nextSource = "tool-loop-source-2";
    const nextRaw = "continue the synthetic task";
    const nextPrompt = `${nextRaw}\n\nCurrent time: 2030-05-01T00:01:00Z`;
    const secondExecuteTool = vi.fn(async () => ({ content: "second synthetic effect result" }));
    for await (const _event of runtime.run(
      {
        ...base,
        runId: "native-tool-loop-2",
        sourceMessageId: nextSource,
        durableNativeHistorySourceMessageId: nextSource,
        prompt: nextPrompt,
        history: [
          { role: "user", id: source, content: raw },
          { role: "assistant", id: "assistant-tool-loop-1", content: firstAnswer },
          { role: "user", id: nextSource, content: nextRaw },
        ],
        executeTool: secondExecuteTool,
      },
      { ...f.scope.context, runLease: { owner: "worker", fence: 2 } },
    )) {
      /* drain */
    }
    expect(f.received).toHaveLength(2);
    expect(f.received[1]?.restore?.sessionId).toBe("fixture-session");
    expect(googleAcpContextHistory(f.received[1]!.context!)).toEqual([
      { role: "user", content: nextPrompt },
    ]);
    expect(secondExecuteTool).toHaveBeenCalledOnce();
    expect(f.hostCount()).toBe(0);
  });
  it("rejects a changed prior user message before restoring the native cursor", async () => {
    const f = fixture();
    const runtime = f.captureRuntime(new PiAgentRuntime({ createProvider: f.factory }));
    const firstRequest: AgentRunRequest = {
      ...f.scope.request,
      runId: "history-edit-first",
      sourceMessageId: "edited-source-1",
      durableNativeHistorySourceMessageId: "edited-source-1",
      model: f.config,
      prompt: "first question\n\nCurrent time: 2030-02-01T00:00:00Z",
      instructions: "fixture instructions",
      history: [{ role: "user", id: "edited-source-1", content: "first question" }],
      tools: [],
    };
    for await (const _event of runtime.run(firstRequest, f.scope.context)) {
      /* drain */
    }
    const editedPrompt = "second question\n\nCurrent time: 2030-02-01T00:01:00Z";
    for await (const _event of runtime.run(
      {
        ...firstRequest,
        runId: "history-edit-second",
        sourceMessageId: "edited-source-2",
        durableNativeHistorySourceMessageId: "edited-source-2",
        prompt: editedPrompt,
        history: [
          { role: "user", id: "edited-source-1", content: "edited first question" },
          { role: "assistant", id: "edited-answer-1", content: "fixture answer" },
          { role: "user", id: "edited-source-2", content: "second question" },
        ],
      },
      { ...f.scope.context, runLease: { owner: "worker", fence: 2 } },
    )) {
      /* drain */
    }
    expect(f.received[1]?.restore).toBeUndefined();
    expect(googleAcpContextHistory(f.received[1]!.context!)).toContainEqual({
      role: "user",
      content: "edited first question",
    });
  });
  it.each([
    ["missing source mapping", [{ role: "user", id: "other-source", content: "first question" }]],
    [
      "duplicate source mapping",
      [
        { role: "user", id: "duplicate-source", content: "first question" },
        { role: "user", id: "duplicate-source", content: "first question" },
      ],
    ],
    ["source id mismatch", [{ role: "user", id: "duplicate-source", content: "first question" }]],
    ["reaction source", [{ role: "user", id: "reaction-source", content: "first question" }]],
    ["routine source", [{ role: "user", id: "routine-source", content: "first question" }]],
  ] as const)("does not claim durable state for %s", async (caseName, history) => {
    const f = fixture();
    const runtime = f.captureRuntime(new PiAgentRuntime({ createProvider: f.factory }));
    const isReaction = caseName === "reaction source";
    const isRoutine = caseName === "routine source";
    for await (const _event of runtime.run(
      {
        ...f.scope.request,
        runId: `ineligible-${caseName.replaceAll(" ", "-")}`,
        ...(isReaction ? {} : { durableNativeHistorySourceMessageId: "duplicate-source" }),
        sourceMessageId: caseName === "source id mismatch" ? "other-source" : "duplicate-source",
        ...(isRoutine ? { routineId: "synthetic-routine" } : {}),
        model: f.config,
        prompt: "first question\n\nCurrent time: 2030-03-01T00:00:00Z",
        instructions: "fixture instructions",
        history: [...history],
        tools: [],
      },
      f.scope.context,
    )) {
      /* drain */
    }
    expect(f.prisma.nativeConversationState.upsert).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });
  it.each(["missing", "prefix", "image", "unattested", "model", "system", "compaction"])(
    "rejects oversized accumulated history with %s state before helper initialization",
    async (change) => {
      const f = fixture();
      const first = normalizeContext({
        messages: [{ role: "user", content: "a".repeat(64 * 1024), timestamp: 0 }],
      });
      const answer = await f.turn(first);
      const next = normalizeContext({
        messages: [
          ...first.messages,
          answer,
          { role: "user", content: "b".repeat(64 * 1024), timestamp: 1 },
        ],
      });
      if (change === "missing") f.row()!.ciphertext = null;
      if (change === "prefix")
        next.messages[0] = { role: "user", content: "c".repeat(64 * 1024), timestamp: 0 };
      if (change === "image") f.setRuntimeIdentity(`docker-image:sha256:${"b".repeat(64)}`);
      if (change === "model") f.config.id = "other-model";
      if (change === "unattested") f.setRuntimeIdentity(undefined);
      if (change === "compaction") f.setGeneration(1);
      const context =
        change === "system"
          ? normalizeContext({ systemPrompt: "changed", messages: next.messages })
          : next;
      const result = await f.turn(context);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("context byte limit");
      expect(f.received[1]?.initialized).toBeUndefined();
      expect(f.hostCount()).toBe(0);
      expect(f.put).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects an oversized new delta even when the cached prefix matches", async () => {
    const f = fixture();
    const first = firstContext();
    const answer = await f.turn(first);
    const context = normalizeContext({
      messages: [
        ...first.messages,
        answer,
        { role: "user", content: "x".repeat(128 * 1024), timestamp: 1 },
      ],
    });
    expect((await f.turn(context)).stopReason).toBe("error");
    expect(f.received[1]?.initialized).toBeUndefined();
    expect(f.row()?.ciphertext).toBeNull();
    expect(f.hostCount()).toBe(0);
    expect(f.put).toHaveBeenCalledTimes(1);
  });
  it.each([2_195_456, 4 * 1024 * 1024])(
    "round-trips a %i-byte opaque snapshot through relay, encryption and next-turn restore",
    async (size) => {
      const f = fixture();
      const bytes = Buffer.alloc(size, 13);
      f.setSnapshotBytes(bytes);
      const first = firstContext();
      const answer = await f.turn(first);
      expect(answer.stopReason).toBe("stop");
      expect(Buffer.byteLength(f.row()!.ciphertext as string)).toBeLessThan(8 * 1024 * 1024);
      expect((await f.turn(nextContext(first, answer))).stopReason).toBe("stop");
      expect(Buffer.from(f.received[1]!.restore!.data, "base64").equals(bytes)).toBe(true);
      expect(f.put).toHaveBeenCalledTimes(2);
      expect(f.hostCount()).toBe(0);
    },
  );
  it("reports a snapshot exceeding 4MiB as failure rather than claiming durable success", async () => {
    const f = fixture();
    const first = firstContext();
    const answer = await f.turn(first);
    f.setSnapshotBytes(Buffer.alloc(4 * 1024 * 1024 + 1, 1));
    const next = nextContext(first, answer);
    expect((await f.turn(next)).stopReason).toBe("error");
    expect(f.row()?.ciphertext).toBeNull();
    expect(f.put).toHaveBeenCalledTimes(1);
    expect(f.hostCount()).toBe(0);
    f.setSnapshotBytes(Buffer.from("new bounded state"));
    expect((await f.turn(next)).stopReason).toBe("stop");
    expect(f.received[2]?.restore).toBeUndefined();
  });
  it("bounds the full persistent caller envelope before host allocation", async () => {
    const f = fixture();
    const before = boundary.open.mock.calls.length;
    const context = normalizeContext({
      messages: [{ role: "user", content: "x".repeat(2 * 1024 * 1024), timestamp: 0 }],
    });
    expect((await f.turn(context)).stopReason).toBe("error");
    expect(boundary.open.mock.calls.length).toBe(before);
    expect(f.prisma.nativeConversationState.upsert).not.toHaveBeenCalled();
  });
  it("normalizes multiple chunks without weakening direct-provider prefix checks", async () => {
    const f = fixture();
    f.setChunks(["fixture ", "answer"]);
    const first = firstContext();
    const answer = await f.turn(first);
    expect(answer.content).toHaveLength(2);
    await f.turn(nextContext(first, answer));
    expect(f.received[1]?.restore?.sessionId).toBe("fixture-session");
  });
  it.each(["helper", "missing-fence", "main"])(
    "rejects oversized %s input before helper initialization",
    async (kind) => {
      const f = fixture();
      if (kind === "helper") f.scope.agentNamespace = "helper";
      if (kind === "missing-fence") delete f.scope.context!.runLease;
      const before = boundary.open.mock.calls.length;
      const result = await f.turn(
        normalizeContext({
          messages: [{ role: "user", content: "x".repeat(128 * 1024), timestamp: 0 }],
        }),
      );
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("context byte limit");
      expect(boundary.open.mock.calls.length).toBe(before + (kind === "main" ? 1 : 0));
      expect(f.received.every((record) => record.context === undefined)).toBe(true);
    },
  );
  it.each(["helper", "missing-fence", "main"])(
    "counts projected gate names before initializing a near-limit %s helper",
    async (kind) => {
      const f = fixture();
      if (kind === "helper") f.scope.agentNamespace = "helper";
      if (kind === "missing-fence") delete f.scope.context!.runLease;
      const tools = [{ name: "x", description: "Fixture", parameters: Type.Object({}) }];
      const empty = normalizeContext({
        messages: [{ role: "user", content: "", timestamp: 0 }],
        tools,
      });
      const padding =
        GOOGLE_ACP_EXPERIMENTAL_INPUT_BYTES - prepareGoogleAcpInput(empty, tools).bytes;
      const context = normalizeContext({
        messages: [{ role: "user", content: "x".repeat(padding), timestamp: 0 }],
        tools,
      });
      // Original short names fit exactly; the actual opaque names do not.
      expect(prepareGoogleAcpInput(context, tools).bytes).toBe(GOOGLE_ACP_EXPERIMENTAL_INPUT_BYTES);
      const before = boundary.open.mock.calls.length;
      const result = await f.turn(context);
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("context byte limit");
      expect(boundary.open.mock.calls.length).toBe(before + (kind === "main" ? 1 : 0));
      expect(f.received.every((record) => record.context === undefined)).toBe(true);
    },
  );
  it("round-trips actual Pi output through encrypted state and sends only the next-turn delta", async () => {
    const f = fixture();
    const first = firstContext();
    const answer = await f.turn(first);
    expect(answer.stopReason).toBe("stop");
    expect(f.row()?.ciphertext).toMatch(/^rkz1:/);
    expect(f.row()?.ciphertext).not.toContain("sensitive-native-state");
    const next = await f.turn(nextContext(first, answer));
    expect(next.stopReason).toBe("stop");
    expect(f.received[1]?.restore?.sessionId).toBe("fixture-session");
    expect(googleAcpContextHistory(f.received[1]!.context!)).toEqual([
      { role: "user", content: "second question" },
    ]);
    expect(getCurrentSystemPrompt(f.received[1]!.context!.messages)).toBe("fixture instructions");
    expect(f.put).toHaveBeenCalledTimes(2);
  });
  it.each(["helper", "missing-fence", "missing-generation", "missing-history"])(
    "keeps %s ephemeral without claiming main state",
    async (kind) => {
      const f = fixture();
      if (kind === "helper") f.scope.agentNamespace = "helper-execution";
      if (kind === "missing-fence") delete f.scope.context!.runLease;
      if (kind === "missing-generation")
        delete (f.config.nativeAuth as { accountGeneration?: string }).accountGeneration;
      if (kind === "missing-history") delete f.scope.request.historyCompactionGeneration;
      expect((await f.turn(firstContext())).stopReason).toBe("stop");
      expect(f.prisma.nativeConversationState.upsert).not.toHaveBeenCalled();
      expect(f.put).not.toHaveBeenCalled();
    },
  );
  it("rejects reconnect between credential resolution and host allocation", async () => {
    const f = fixture();
    f.setSecret("replacement-generation");
    const before = boundary.open.mock.calls.length;
    expect((await f.turn(firstContext())).stopReason).toBe("error");
    expect(boundary.open.mock.calls.length).toBe(before);
    expect(f.prisma.nativeConversationState.upsert).not.toHaveBeenCalled();
  });
  it("rejects reconnect during private allocation before transmitting credentials or state", async () => {
    const f = fixture();
    const open = boundary.open.getMockImplementation()!;
    boundary.open.mockImplementation(async (...args) => {
      const process = await open(...args);
      f.setSecret("replacement-during-open");
      return process;
    });
    expect((await f.turn(firstContext())).stopReason).toBe("error");
    expect(f.row()).toBeUndefined();
    expect(f.received[0]?.context).toBeUndefined();
    expect(f.put).not.toHaveBeenCalled();
  });
  it("reports unknown outcome when the run fence is lost before snapshot commit", async () => {
    const f = fixture();
    let calls = 0;
    f.prisma.run.updateMany.mockImplementation(async () => ({ count: ++calls === 1 ? 1 : 0 }));
    expect((await f.turn(firstContext())).stopReason).toBe("stop");
    expect(f.row()?.ciphertext).toBeNull();
    expect(f.put).not.toHaveBeenCalled();
  });
  it.each(["prefix", "system", "tools", "compaction", "model"])(
    "invalidates %s changes rather than loading stale native state",
    async (change) => {
      const f = fixture();
      const first = firstContext();
      const answer = await f.turn(first);
      let next = nextContext(first, answer);
      if (change === "prefix")
        next = normalizeContext({
          messages: [
            ...first.messages.filter((message) => message.role === "system"),
            { role: "user", content: "edited question", timestamp: 0 },
            answer,
            { role: "user", content: "second question", timestamp: 1 },
          ],
        });
      if (change === "system")
        next = normalizeContext({
          systemPrompt: "changed instructions",
          messages: next.messages.filter((message) => message.role !== "system"),
        });
      if (change === "tools")
        next = normalizeContext({
          systemPrompt: "fixture instructions",
          tools: [{ name: "changed_tool", description: "Changed", parameters: Type.Object({}) }],
          messages: next.messages.filter((message) => message.role !== "system"),
        });
      if (change === "compaction") f.setGeneration(1);
      if (change === "model") f.config.id = "changed-model";
      expect((await f.turn(next)).stopReason).toBe("stop");
      expect(f.received[1]?.restore).toBeUndefined();
      expect(googleAcpContextHistory(f.received[1]!.context!).length).toBe(3);
    },
  );
  it("leaves prior state consumed after unknown outcome", async () => {
    const f = fixture();
    const first = firstContext();
    const answer = await f.turn(first);
    f.failPrompt();
    expect((await f.turn(nextContext(first, answer))).stopReason).toBe("error");
    expect(f.row()?.ciphertext).toBeNull();
    expect(f.put).toHaveBeenCalledTimes(1);
  });
  it("recovers after an ordinary failed process and resumes only the new completed state", async () => {
    const f = fixture();
    const first = firstContext();
    const answer = await f.turn(first);
    const second = nextContext(first, answer);
    f.failPrompt();
    expect((await f.turn(second)).stopReason).toBe("error");
    expect(f.received[1]?.restore?.sessionId).toBe("fixture-session");
    expect(f.row()?.ciphertext).toBeNull();

    // A new user-initiated run is allowed after the failed host is destroyed.
    // It must receive complete history, never the consumed pre-failure database.
    f.recoverPrompt();
    f.scope.request.runId = "recovery-run";
    f.scope.context!.runLease = { owner: "worker", fence: 2 };
    const recovered = await f.turn(second);
    expect(recovered.stopReason).toBe("stop");
    expect(f.received[2]?.restore).toBeUndefined();
    expect(googleAcpContextHistory(f.received[2]!.context!)).toEqual(
      googleAcpContextHistory(second),
    );
    expect(f.row()?.ciphertext).toMatch(/^rkz1:/);

    const third = nextContext(second, recovered);
    f.scope.request.runId = "post-recovery-run";
    f.scope.context!.runLease = { owner: "worker", fence: 3 };
    expect((await f.turn(third)).stopReason).toBe("stop");
    expect(f.received[3]?.restore?.sessionId).toBe("fixture-session");
    expect(googleAcpContextHistory(f.received[3]!.context!)).toEqual([
      { role: "user", content: "second question" },
    ]);
    expect(f.received).toHaveLength(4); // No automatic replay of the failed prompt.
    expect(f.put).toHaveBeenCalledTimes(3);
  });
  it("cancels an active restored prompt and lets the next run rebuild then resume", async () => {
    const f = fixture();
    const first = firstContext();
    const answer = await f.turn(first);
    const second = nextContext(first, answer);
    const controller = new AbortController();
    const started = f.parkPrompt();
    const cancelled = f.turn(second, controller.signal);
    await started;
    controller.abort();
    expect((await cancelled).stopReason).toBe("aborted");
    expect(f.row()?.ciphertext).toBeNull();
    expect(f.put).toHaveBeenCalledTimes(1);

    f.scope.request.runId = "after-cancel";
    f.scope.context!.runLease = { owner: "worker", fence: 2 };
    const restarted = await f.turn(second);
    expect(restarted.stopReason).toBe("stop");
    expect(f.received[2]?.restore).toBeUndefined();
    expect(googleAcpContextHistory(f.received[2]!.context!)).toEqual(
      googleAcpContextHistory(second),
    );
    expect((await f.turn(nextContext(second, restarted))).stopReason).toBe("stop");
    expect(f.received[3]?.restore?.sessionId).toBe("fixture-session");
    expect(f.received).toHaveLength(4);
    expect(f.put).toHaveBeenCalledTimes(3);
  });
  it("starts fresh after completed reconnect and resumes the replacement account generation", async () => {
    const f = fixture();
    const first = firstContext();
    const answer = await f.turn(first);
    f.setSecret("replacement-generation");
    f.config.nativeAuth = { ...f.config.nativeAuth!, accountGeneration: "replacement-generation" };
    const second = nextContext(first, answer);
    const replacement = await f.turn(second);
    expect(replacement.stopReason).toBe("stop");
    expect(f.received[1]?.restore).toBeUndefined();
    expect(googleAcpContextHistory(f.received[1]!.context!)).toEqual(
      googleAcpContextHistory(second),
    );
    expect(f.row()?.accountGeneration).toBe("replacement-generation");
    expect((await f.turn(nextContext(second, replacement))).stopReason).toBe("stop");
    expect(f.received[2]?.restore?.sessionId).toBe("fixture-session");
    expect(googleAcpContextHistory(f.received[2]!.context!)).toHaveLength(1);
    expect(f.put).toHaveBeenCalledTimes(3);
  });
  it("invalidates cached state when the actual host image changes", async () => {
    const f = fixture();
    const first = firstContext();
    const answer = await f.turn(first);
    f.setRuntimeIdentity(`docker-image:sha256:${"b".repeat(64)}`);
    expect((await f.turn(nextContext(first, answer))).stopReason).toBe("stop");
    expect(f.received[1]?.restore).toBeUndefined();
    expect(googleAcpContextHistory(f.received[1]!.context!)).toHaveLength(3);
  });
  it("keeps older hosts without an attested image identity ephemeral", async () => {
    const f = fixture();
    f.setRuntimeIdentity(undefined);
    expect((await f.turn(firstContext())).stopReason).toBe("stop");
    expect(f.prisma.nativeConversationState.upsert).not.toHaveBeenCalled();
    expect(f.put).not.toHaveBeenCalled();
  });
  it("leaves tool-turn state consumed rather than inventing a transcript cursor", async () => {
    const f = fixture();
    f.enableTools();
    const context = normalizeContext({
      systemPrompt: "fixture instructions",
      tools: [{ name: "fixture_tool", description: "Fixture", parameters: Type.Object({}) }],
      messages: [{ role: "user", content: "first question", timestamp: 0 }],
    });
    f.setProvenance("first question", "fixture-tool-source");
    const adapter = f.factory(f.config, f.scope)!;
    const result = await adapter.provider.streamSimple(googleAcpModel(f.config), context).result();
    expect(result.stopReason).toBe("toolUse");
    await adapter.close();
    expect(f.row()?.ciphertext).toBeNull();
    expect(f.put).not.toHaveBeenCalled();
  });
});
