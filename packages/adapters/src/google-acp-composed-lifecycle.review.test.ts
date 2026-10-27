import { PassThrough } from "node:stream";
import type { AgentRunRequest, AgentRuntimeEvent, ProcessEvent } from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { blocksToAgentHistoryText } from "@rakazo/core";
import type { AppendEventInput, Prisma } from "@rakazo/db";
import {
  appendEventInTransaction,
  finalizeRun as finalizeRunTransaction,
  type nativeContextCursor,
} from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AccountOperationProcess } from "./account-operation-host.js";
import { serveHostedRunRelay } from "./acp-run-relay.js";
import { loadBotMessageContext } from "./bot-messages.js";
import { builtinAgentTools } from "./builtin-tools.js";
import type * as ComputerLifecycleModule from "./computer-lifecycle.js";
import { createRunExecutor } from "./executor.js";
import { googleAcpContextHistory } from "./google-acp-provider.js";
import { createAccountModelProvider } from "./google-acp-remote.js";
import type { NativeConversationRunCandidate } from "./native-conversation-candidate.js";
import { emitNativeConversationCandidate } from "./native-conversation-candidate.js";
import { PiAgentRuntime } from "./pi-runtime.js";
import { userProgressClientNonce } from "./user-progress.js";

vi.mock("./computer-lifecycle.js", async (importOriginal) => ({
  ...(await importOriginal<typeof ComputerLifecycleModule>()),
  acquireComputerExecutionLease: async () => null,
  provisionComputer: async () => ({ id: "computer-1", kind: "desktop" }),
}));

vi.mock("./bot-messages.js", () => ({
  loadBotMessageContext: vi.fn(async () => ({
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "FYI",
    intent: "fyi",
    hop: 1,
    repliesToRequest: false,
  })),
  returnBotMessageOutcome: vi.fn(async () => undefined),
}));

const accountHostBoundary = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("./account-operation-host.js", () => ({
  openAccountOperationProcess: accountHostBoundary.open,
}));

const syntheticGoogleProfile = {
  version: 1 as const,
  files: [
    { path: ".gemini/antigravity-acp/settings.json", data: '{"auth":{"type":"oauth-personal"}}' },
    {
      path: ".gemini/antigravity-acp/acp_token.json",
      data: JSON.stringify({
        refresh_token: "synthetic",
        client_id: "synthetic",
        client_secret: "synthetic",
        token_uri: "https://oauth2.googleapis.com/token",
      }),
    },
  ],
};
const syntheticGoogleSecret = JSON.stringify({
  kind: "native",
  provider: "google-antigravity",
  profile: syntheticGoogleProfile,
});

async function runTurn(
  finalText: string,
  silent = true,
  narration: string | string[] = "I will check that.",
  secrets: string[] = [],
  intent: "fyi" | "request" | "question" = "fyi",
  options: {
    trigger?: string;
    prompt?: string;
    doneText?: string;
    splitText?: boolean;
    priorProgressText?: string;
    runtimeEvents?: AgentRuntimeEvent[];
    runtimeFailure?: boolean;
    runtimeError?: Error;
    runtimeCancel?: boolean;
    failHelperId?: string;
    failMessageOnce?: boolean;
    history?: Array<{ id: string; seq: number; role: string; text: string; clientNonce?: string }>;
    nativeCandidate?: boolean;
    sourceMessageId?: string;
    runtime?: Parameters<typeof createRunExecutor>[0]["runtime"];
    runtimeFactory?: (
      prisma: Record<string, any>,
    ) => Parameters<typeof createRunExecutor>[0]["runtime"];
    finalizeWithDatabase?: boolean;
    onFinalize?: (prisma: Record<string, any>, input: Record<string, any>) => Promise<unknown>;
    nativeStateStore?: { row?: Record<string, any> };
    disabledBuiltinTools?: string[];
    runId?: string;
    historyStore?: {
      messages: Array<Record<string, any>>;
      savedEvents: AppendEventInput[];
      history: Array<Record<string, any>>;
      txCounter: number;
      activeTxId?: number;
      txLog: Array<{ kind: string; txId: number }>;
    };
  } = {},
) {
  vi.mocked(loadBotMessageContext).mockResolvedValue({
    kind: "bot_message_received",
    fromBotId: "caller",
    fromBotName: "Caller",
    text: "Look again",
    intent,
    hop: 1,
    repliesToRequest: false,
  });
  const run = {
    id: options.runId ?? "run-1",
    botId: "bot-1",
    threadId: "thread-1",
    taskId: "task-1",
    spaceId: "space-1",
    userId: "user-1",
    status: "queued",
    trigger: options.trigger ?? (silent ? "bot_message" : "user"),
    sourceMessageId: options.sourceMessageId ?? "source-1",
    leaseFence: 0,
  };
  const nativeStateStore = options.nativeStateStore ?? {};
  let boundCursor: ReturnType<typeof nativeContextCursor> | undefined;
  let candidateDiscards = 0;
  const runtimeRequests: AgentRunRequest[] = [];
  const runtimeRun = vi.fn(async function* (_request: AgentRunRequest) {
    runtimeRequests.push(_request);
    if (options.nativeCandidate) {
      let bound = false;
      let discarded = false;
      const candidate = {
        provider: _request.model.provider,
        modelId: _request.model.id,
        sourceMessageId: _request.sourceMessageId!,
        canonicalPrefix: ["qualified prior native prefix"],
        pending: {
          bindCursor(cursor: ReturnType<typeof nativeContextCursor>) {
            bound = true;
            boundCursor = cursor;
            return Object.freeze({}) as never;
          },
          discard() {
            if (!bound && !discarded) {
              discarded = true;
              candidateDiscards += 1;
            }
          },
        },
      } as unknown as NativeConversationRunCandidate;
      emitNativeConversationCandidate(_request, candidate);
    }
    if (options.runtimeEvents) {
      for (const event of options.runtimeEvents) {
        yield event;
      }
      if (options.runtimeCancel) {
        run.status = "cancelled";
        yield { type: "done" as const };
      }
      if (options.runtimeFailure) {
        throw options.runtimeError ?? new Error("fixture runtime failure");
      }
      return;
    }
    const narrations = Array.isArray(narration) ? narration : [narration];
    for (const [index, text] of narrations.entries()) {
      for (const chunk of options.splitText ? [...text] : [text]) {
        yield { type: "text" as const, text: chunk };
      }
      yield {
        type: "tool" as const,
        name: "read_file",
        args: {},
        executionId: `call-${index + 1}`,
      };
    }
    if (finalText) yield { type: "text" as const, text: finalText };
    yield { type: "done" as const, text: options.doneText ?? narrations.join("") + finalText };
  });
  const messages: Array<Record<string, any>> = options.historyStore?.messages ?? [];
  const savedEvents: AppendEventInput[] = options.historyStore?.savedEvents ?? [];
  let failMessage = options.failMessageOnce;
  const prisma = new Proxy(
    {
      user: { findUnique: vi.fn(async () => null) },
      run: {
        findUnique: vi.fn(async () => run),
        findUniqueOrThrow: vi.fn(async () => run),
        findFirst: vi.fn(async () => null),
        updateMany: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          Object.assign(run, data);
          return { count: 1 };
        }),
      },
      chatGroup: { findMany: vi.fn(async () => []) },
      bot: {
        findUniqueOrThrow: vi.fn(async () => ({
          id: run.botId,
          name: "Assistant",
          title: "Assistant",
          description: "Test assistant",
          modelProvider: "google-antigravity",
          modelId: "fixture-model",
          thinkingLevel: null,
          computerId: "computer-1",
          computerSwitching: false,
          memoryScope: null,
          disabledBuiltinTools: options.disabledBuiltinTools ?? null,
          computer: { id: "computer-1", scope: "dedicated" },
        })),
        findMany: vi.fn(async () => []),
      },
      attempt: {
        create: vi.fn(async () => ({ id: "attempt-1" })),
        update: vi.fn(),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      thread: {
        update: vi.fn(async () => ({
          nextMessageSeq: messages.length + 3,
          nextEventSeq: savedEvents.length + 1,
        })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: run.threadId,
          groupId: null,
          historyCompactionSummary: null,
          historyCompactedUpToSeq: null,
          historyCompactionGeneration: 0,
          nextMessageSeq: 3,
        })),
      },
      event: {
        create: vi.fn(async ({ data }: { data: AppendEventInput }) => {
          if (
            data.type === "thread.subagent" &&
            (data.payload as { status?: string; agentId?: string }).status === "failed" &&
            (data.payload as { agentId?: string }).agentId === options.failHelperId
          )
            throw new Error("fixture settlement unavailable");
          savedEvents.push(data);
          return { ...data, seq: savedEvents.length, createdAt: new Date() };
        }),
      },
      message: {
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => {
          if (failMessage) {
            failMessage = false;
            throw new Error("fixture message unavailable");
          }
          const message: Record<string, any> = { ...data, id: `message-${messages.length + 1}` };
          messages.push(message);
          if (options.historyStore) {
            const txId = options.historyStore.activeTxId ?? 0;
            options.historyStore.txLog.push({ kind: "message", txId });
            options.historyStore.history.push({
              ...message,
              role: "bot",
              text: blocksToAgentHistoryText(message.blocks as MessageBlock[]),
            });
          }
          return message;
        }),
        findMany: vi.fn(async ({ where }: { where: { runId?: string } }) =>
          !where.runId && (options.historyStore?.history ?? options.history)
            ? (options.historyStore?.history ?? options.history)!.toReversed().map((message) => ({
                ...message,
                threadId: run.threadId,
                botId: message.role === "bot" ? run.botId : null,
                runId: null,
                blocks: [{ kind: "text", text: message.text }],
                createdAt: new Date("2026-10-24T08:00:00.000Z"),
                replyToMessageId: null,
                replyQuote: null,
                replyTo: null,
                clientNonce: message.clientNonce ?? null,
              }))
            : where.runId === run.id && options.priorProgressText
              ? [
                  {
                    blocks: [{ kind: "text", text: options.priorProgressText }],
                    clientNonce: userProgressClientNonce(run.id),
                  },
                ]
              : [],
        ),
        findUnique: vi.fn(async () =>
          run.trigger === "messaging"
            ? { blocks: [{ kind: "channel_message", channelId: "channel-1" }] }
            : null,
        ),
        findFirst: vi.fn(async () => null),
      },
      task: {
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUniqueOrThrow: vi.fn(async () => ({
          id: run.taskId,
          prompt: options.prompt ?? "Look again",
        })),
      },
      computer: { updateMany: vi.fn(async () => ({ count: 1 })) },
      connection: { findMany: vi.fn(async () => []) },
      userModelPreference: {
        findFirst: vi.fn<(...args: unknown[]) => Promise<Record<string, unknown> | null>>(
          async () => null,
        ),
      },
      secret: {
        findFirst: vi.fn(async () => ({
          id: "loaded-generation",
          ciphertext: syntheticGoogleSecret,
        })),
      },
      userModelCredential: { findFirst: vi.fn(async () => null) },
      usageRecord: { createMany: vi.fn(async () => ({ count: 1 })) },
      modelCreditEntry: { findUnique: vi.fn(async () => null) },
      spaceSettingOverride: { findUnique: vi.fn(async () => null) },
      userModelRoleChoice: { findMany: vi.fn(async () => []) },
      userActionApprovalRule: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
      },
      actionApprovalRule: { findMany: vi.fn(async () => []), findUnique: vi.fn(async () => null) },
      userActionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
      actionAutoReviewPreference: { findUnique: vi.fn(async () => null) },
      deploymentSettings: {
        findUnique: vi.fn(async () => ({
          defaultModelProvider: "google-antigravity",
          defaultModelId: "fixture-model",
        })),
      },
      taughtSkill: { findMany: vi.fn(async () => []) },
      agentSecret: { findMany: vi.fn(async () => []) },
      botSecret: { findMany: vi.fn(async () => []) },
      botDeletion: { findMany: vi.fn(async () => []) },
      agentSkill: { findMany: vi.fn(async () => []) },
      scratchpadItem: { findMany: vi.fn(async () => []) },
      externalEffect: {
        findMany: vi.fn(async () => []),
        findUnique: vi.fn(async () => null),
        create: vi.fn(async ({ data }: { data: Record<string, any> }) => ({
          id: "effect-1",
          ...data,
        })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        deleteMany: vi.fn(async () => ({ count: 0 })),
      },
      computerExecutionLease: {
        updateManyAndReturn: vi.fn(async () => [{ fence: 1 }]),
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
      $queryRaw: vi.fn(async () => [{ id: "row-1", scope: "dedicated" }]),
      $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>): Promise<unknown> => {
        const messageCount = messages.length;
        const eventCount = savedEvents.length;
        const historyCount = options.historyStore?.history.length ?? 0;
        const txId = options.historyStore ? ++options.historyStore.txCounter : 0;
        if (options.historyStore) options.historyStore.activeTxId = txId;
        try {
          return await fn(prisma);
        } catch (error) {
          messages.length = messageCount;
          savedEvents.length = eventCount;
          if (options.historyStore) options.historyStore.history.length = historyCount;
          throw error;
        } finally {
          if (options.historyStore) options.historyStore.activeTxId = undefined;
        }
      }),
    },
    {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (value === undefined && typeof property === "string" && !property.startsWith("$"))
          throw new Error(`Missing synthetic Prisma delegate: ${property}`);
        return value;
      },
    },
  );
  // Add the production transaction delegates used by finalizeRun. This transaction
  // client is also passed to the Google factory below, so claim and promotion share
  // the same state rows as the history write.
  Object.assign(prisma, {
    $contentEncryption: () => ({
      ring: {
        encryptWrites: false,
        current: async (spaceId: string) => ({
          id: "fixture-key",
          spaceId,
          key: new Uint8Array(32).fill(5),
        }),
        byId: async (id: string) => ({ id, spaceId: "space-1", key: new Uint8Array(32).fill(5) }),
      },
    }),
    accountOperationHost: {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => null),
    },
    nativeConversationState: {
      upsert: vi.fn(
        async ({
          create,
          update,
        }: {
          create: Record<string, any>;
          update: Record<string, any>;
        }) => {
          if (!nativeStateStore.row)
            nativeStateStore.row = { ...create, ciphertext: null, claimHostId: null };
          else if (update.revision && typeof update.revision === "object")
            nativeStateStore.row.revision += (update.revision as { increment: number }).increment;
          return { ...nativeStateStore.row };
        },
      ),
      update: vi.fn(async ({ data }: { data: Record<string, any> }) =>
        Object.assign(nativeStateStore.row!, data),
      ),
      updateMany: vi.fn(
        async ({ where, data }: { where: Record<string, any>; data: Record<string, any> }) => {
          if (!nativeStateStore.row) return { count: 0 };
          for (const [key, value] of Object.entries(where))
            if (nativeStateStore.row[key] !== value) return { count: 0 };
          if (typeof data.ciphertext === "string" && options.historyStore)
            options.historyStore.txLog.push({
              kind: "promotion",
              txId: options.historyStore.activeTxId ?? 0,
            });
          Object.assign(nativeStateStore.row, data);
          return { count: 1 };
        },
      ),
    },
    userModelCredential: {
      findFirst: vi.fn(async () => ({
        id: "connection",
        provider: "google-antigravity",
        secretId: "loaded-generation",
      })),
      findMany: vi.fn(async () => [
        {
          id: "connection",
          provider: "google-antigravity",
          secretId: "loaded-generation",
          updatedAt: new Date(),
          createdAt: new Date(),
        },
      ]),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    thread: Object.assign(prisma.thread, {
      updateMany: vi.fn(async () => ({ count: 1 })),
      findFirst: vi.fn(async () => ({ id: run.threadId })),
    }),
    event: Object.assign(prisma.event, {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
    }),
    steeringMessage: {
      deleteMany: vi.fn(async () => ({ count: 0 })),
      updateMany: vi.fn(async () => ({ count: 0 })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
    },
    message: Object.assign(prisma.message, {
      findFirst: vi.fn(async () => null),
    }),
    bot: Object.assign(prisma.bot, { update: vi.fn(async () => ({})) }),
    attempt: Object.assign(prisma.attempt, {
      updateMany: vi.fn(async () => ({ count: 1 })),
    }),
    task: Object.assign(prisma.task, {
      updateMany: vi.fn(async () => ({ count: 1 })),
    }),
    secret: Object.assign(prisma.secret, {
      deleteMany: vi.fn(async () => ({ count: 0 })),
    }),
  });
  const finalizeRun = vi.fn(
    async (_input: {
      blocks: MessageBlock[];
      outcome?: string;
      nativeConversationCandidate?: unknown;
    }) => {
      if (options.onFinalize) return options.onFinalize(prisma, _input as Record<string, any>);
      if (options.finalizeWithDatabase)
        return finalizeRunTransaction(prisma as never, _input as never);
      return { continuationRunId: null };
    },
  );
  const append = vi.fn(async (event: AppendEventInput) =>
    appendEventInTransaction(prisma as unknown as Prisma.TransactionClient, event),
  );
  const pauseRunForInput = vi.fn(async () => ({ continuationRunId: null }));
  const writeFile = vi.fn(
    async (_computer: unknown, _file: { path: string; content: Uint8Array }) => {},
  );
  const executor = createRunExecutor({
    deploymentModelKey: "fixture-model-key",
    prisma,
    runtime: options.runtimeFactory?.(prisma) ??
      options.runtime ?? {
        describe: () => ({ capabilities: { scripted: false } }),
        run: runtimeRun,
      },
    sandbox: {
      describe: () => ({ capabilities: { graphical: false } }),
      readFile: vi.fn(async () => Buffer.from("synthetic read result")),
      writeFile,
      async *exportWorkspace() {
        yield* [];
      },
    },
    home: { commit: vi.fn(async () => "fixture-revision") },
    memory: { read: async () => ({ documents: [] }) },
    memoryProviders: { resolve: async () => null },
    events: {
      append,
      claimSteering: vi.fn(async () => []),
      finalizeRun,
      pauseRunForInput,
      notify: vi.fn(async () => undefined),
    },
    jobs: { enqueue: vi.fn(async () => undefined) },
    secrets,
    secretStore: { load: async (ciphertext: string) => ciphertext },
  } as unknown as Parameters<typeof createRunExecutor>[0]);

  await executor.continueRun(run.id, "worker-1");
  if (!options.runtime && !options.runtimeFactory) expect(runtimeRun).toHaveBeenCalled();
  if (!options.runtimeFailure && !options.runtimeFactory)
    expect(finalizeRun).not.toHaveBeenCalledWith(expect.objectContaining({ outcome: "failed" }));
  return {
    finalizeRun,
    append,
    pauseRunForInput,
    messages,
    savedEvents,
    prisma,
    runtimeRun,
    runtimeRequests,
    boundCursor: () => boundCursor,
    candidateDiscards: () => candidateDiscards,
    nativeStateStore,
    writeFile,
  };
}
describe("composed Google ACP executor lifecycle", () => {
  const currentSource = [{ id: "source-1", seq: 2, role: "user", text: "first synthetic command" }];

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it("composes Google factory, Pi, executor history and transactional promotion/restore", async () => {
    vi.stubEnv("RAKAZO_GOOGLE_ANTIGRAVITY_ENABLED", "true");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("Network forbidden in composed fixture");
      }),
    );
    const nativeStateStore: { row?: Record<string, any> } = {};
    const sharedStore = {
      messages: [] as Array<Record<string, any>>,
      savedEvents: [] as AppendEventInput[],
      history: [{ id: "source-1", seq: 2, role: "user", text: "first synthetic command" }] as Array<
        Record<string, any>
      >,
      txCounter: 0,
      activeTxId: undefined as number | undefined,
      txLog: [] as Array<{ kind: string; txId: number }>,
    };
    const opened: Array<{
      restore?: unknown;
      context?: import("@earendil-works/pi-ai").TranscriptContext;
      conversation?: boolean;
      candidateCalls?: number;
    }> = [];
    const relayErrors: string[] = [];
    let relayCreated = 0;
    let relayPrompts = 0;
    let relayToolCalls = 0;
    let wireWrites = 0;
    let wireBytes = 0;
    const providerDiagnostics: Array<Record<string, unknown>> = [];
    const nativeRequests: AgentRunRequest[] = [];
    const plans = ["First committed answer.", "Second committed answer.", ""];
    let openedCount = 0;
    const runtimeErrors: string[] = [];
    accountHostBoundary.open.mockImplementation(async (_deps, hostInput) => {
      const id = `integration-host-${openedCount}`;
      const responseText = plans[openedCount++] ?? "Empty fallback source.";
      const record: {
        restore?: unknown;
        context?: import("@earendil-works/pi-ai").TranscriptContext;
        conversation?: boolean;
        candidateCalls?: number;
      } = {};
      opened.push(record);
      const input = new PassThrough();
      const output = new PassThrough();
      const serve = serveHostedRunRelay({
        input,
        output,
        createRun: async ({ conversation, callTool, tools }) => {
          relayCreated += 1;
          record.restore = conversation?.restore;
          record.conversation = Boolean(conversation);
          return {
            prompt: async (context, update) => {
              relayPrompts += 1;
              record.context = context;
              const priorUserText = googleAcpContextHistory(context)
                .filter((message) => message.role === "user")
                .map((message) =>
                  typeof message.content === "string"
                    ? message.content
                    : JSON.stringify(message.content),
                )
                .join("\n");
              if (priorUserText.includes("first synthetic command")) {
                const writeTool = tools.find((tool) => tool.name.includes("write_file"));
                if (!writeTool) throw new Error("Synthetic write tool was not offered");
                relayToolCalls += 1;
                await callTool(writeTool.name, {
                  path: "notes/composed.txt",
                  content: "one synthetic effect",
                });
              }
              if (responseText) update(responseText);
            },
            close: async () => {
              record.candidateCalls = (record.candidateCalls ?? 0) + 1;
              await conversation?.offerCandidate({
                version: 1,
                sessionId: "fixture-session",
                data: Buffer.from(`state-${id}`).toString("base64"),
              });
            },
          };
        },
      });
      void serve.catch((error) =>
        relayErrors.push(error instanceof Error ? error.message : String(error)),
      );
      const process: AccountOperationProcess = {
        runtimeIdentity: `docker-image:sha256:${"a".repeat(64)}`,
        lease: {
          id,
          userId: hostInput.actor.userId,
          spaceId: hostInput.actor.spaceId,
          operationId: hostInput.operationId,
          expiresAt: new Date(Date.now() + 60_000),
        },
        events: (async function* (): AsyncGenerator<ProcessEvent> {
          for await (const data of output) yield { type: "stdout", data: data.toString() };
        })(),
        exited: new Promise(() => {}),
        write: async (data) => {
          wireWrites += 1;
          wireBytes += data.byteLength;
          input.write(data);
        },
        end: async () => {
          input.end();
        },
        close: async () => {
          input.destroy();
          output.destroy();
        },
      };
      return process;
    });

    const createRuntime = (prisma: Record<string, any>) => {
      const baseFactory = createAccountModelProvider({
        prisma: prisma as never,
        sandbox: {
          describe: () => ({ id: "private-fixture", contractVersion: "1", adapterVersion: "1" }),
        } as never,
      });
      const factory = (
        config: Parameters<typeof baseFactory>[0],
        scope: Parameters<typeof baseFactory>[1],
      ) => {
        nativeRequests.push(scope.request);
        providerDiagnostics.push({
          provider: config.provider,
          nativeProvider: config.nativeAuth?.provider,
          hasApiKey: Boolean(config.apiKey),
          hasOauth: Boolean(config.oauth),
          connectionId: config.connectionId,
          accountGeneration: config.nativeAuth?.accountGeneration,
          historyGeneration: scope.request.historyCompactionGeneration,
          source: scope.request.durableNativeHistorySourceMessageId,
          provenance: Boolean(scope.request.durableNativeHistoryProvenance),
          namespace: scope.agentNamespace,
          hasRunLease: Boolean(scope.context?.runLease),
        });
        const adapter = baseFactory(config, scope);
        if (!adapter) return adapter;
        const streamSimple = adapter.provider.streamSimple.bind(adapter.provider);
        adapter.provider.streamSimple = ((model, context, streamOptions) => {
          providerDiagnostics.push({
            contextBytes: Buffer.byteLength(JSON.stringify(context)),
            roles: context.messages.map((message) => message.role),
            userText: context.messages
              .filter((message) => message.role === "user")
              .map((message) => (typeof message.content === "string" ? message.content : "parts")),
            hasImage: context.messages.some(
              (message) =>
                Array.isArray(message.content) &&
                message.content.some((part) => part.type === "image"),
            ),
          });
          return streamSimple(model, context, streamOptions);
        }) as typeof adapter.provider.streamSimple;
        return adapter;
      };
      const pi = new PiAgentRuntime({ createProvider: factory });
      return {
        describe: () => pi.describe(),
        abort: (runId: string) => pi.abort(runId),
        async *run(request: AgentRunRequest, context?: Parameters<PiAgentRuntime["run"]>[1]) {
          request.model = {
            ...request.model,
            provider: "google-antigravity",
            id: "fixture-model",
            connectionId: "connection",
            apiKey: undefined,
            oauth: undefined,
            nativeAuth: {
              provider: "google-antigravity",
              accountGeneration: "loaded-generation",
              profile: syntheticGoogleProfile,
              persist: async () => true,
            },
          };
          try {
            yield* pi.run(request, context);
          } catch (error) {
            runtimeErrors.push(error instanceof Error ? error.message : String(error));
            throw error;
          }
        },
      };
    };

    const first = await runTurn("", false, undefined, [], "fyi", {
      trigger: "user",
      prompt: "first synthetic command",
      history: currentSource,
      runtimeFactory: createRuntime,
      finalizeWithDatabase: true,
      nativeStateStore,
      historyStore: sharedStore,
      runId: "run-1",
      disabledBuiltinTools: builtinAgentTools
        .map((tool) => tool.name)
        .filter((name) => name !== "write_file"),
    });
    if (first.finalizeRun.mock.calls[0]?.[0].outcome === "failed")
      throw new Error(
        `Composed fixture runtime failed: ${runtimeErrors.join("; ")}; outcome=${first.finalizeRun.mock.calls[0]?.[0].outcome}; blocks=${JSON.stringify(first.finalizeRun.mock.calls[0]?.[0].blocks)}; events=${JSON.stringify(first.savedEvents)}; providers=${JSON.stringify(providerDiagnostics)}; hosts=${openedCount}; created=${relayCreated}; prompts=${relayPrompts}; toolCalls=${relayToolCalls}; writes=${wireWrites}/${wireBytes}; relay=${relayErrors.join(";")}; state=${JSON.stringify(nativeStateStore.row)}; openRecords=${JSON.stringify(opened)}`,
      );
    expect(first.finalizeRun).toHaveBeenCalledOnce();
    expect(first.finalizeRun.mock.calls[0]?.[0].nativeConversationCandidate).toBeDefined();
    expect(first.messages).toHaveLength(1);
    expect(first.nativeStateStore.row?.ciphertext).toMatch(/^rkz1:/);
    expect(first.messages[0]?.blocks).toContainEqual(
      expect.objectContaining({
        kind: "steps",
        steps: [expect.objectContaining({ label: "Write file", count: 1 })],
      }),
    );
    expect(
      first.writeFile,
      JSON.stringify({ savedEvents: first.savedEvents, relayToolCalls }),
    ).toHaveBeenCalledOnce();
    expect(first.writeFile.mock.calls[0]?.[1]).toMatchObject({
      path: "notes/composed.txt",
      content: new TextEncoder().encode("one synthetic effect"),
    });
    expect(relayToolCalls).toBe(1);

    const storedAssistant = first.messages[0]!;
    expect(sharedStore.history.some((message) => message.id === storedAssistant.id)).toBe(true);
    sharedStore.history.push({
      id: "source-2",
      seq: Number(storedAssistant.seq) + 1,
      role: "user",
      text: "second synthetic question",
    });
    const second = await runTurn("", false, undefined, [], "fyi", {
      trigger: "user",
      prompt: "second synthetic question",
      sourceMessageId: "source-2",
      runtimeFactory: createRuntime,
      finalizeWithDatabase: true,
      nativeStateStore,
      historyStore: sharedStore,
      runId: "run-2",
      disabledBuiltinTools: builtinAgentTools
        .map((tool) => tool.name)
        .filter((name) => name !== "write_file"),
    });
    expect(second.finalizeRun.mock.calls[0]?.[0].nativeConversationCandidate).toBeDefined();
    expect(relayToolCalls).toBe(1);
    expect(second.writeFile).not.toHaveBeenCalled();
    expect(nativeRequests[1]?.sourceMessageId).toBe("source-2");
    expect(nativeRequests[1]?.history).toHaveLength(3);
    expect(nativeRequests[1]?.history).toContainEqual(
      expect.objectContaining({
        id: storedAssistant.id,
        role: "assistant",
        content: expect.stringContaining("First committed answer."),
      }),
    );
    const restoredPromptContext = opened[1]?.context;
    expect(opened[1]?.restore).toBeDefined();
    expect(restoredPromptContext).toBeDefined();
    expect(
      restoredPromptContext!.messages.filter((message) => message.role !== "system"),
    ).toHaveLength(1);
    const restoredUserContent = restoredPromptContext!.messages.find(
      (message) => message.role === "user",
    )?.content;
    expect(Array.isArray(restoredUserContent)).toBe(true);
    expect(JSON.stringify(restoredUserContent)).toContain("second synthetic question");
    expect(JSON.stringify(restoredUserContent)).toContain("Current date and time");
    const firstMessageTx = sharedStore.txLog.find((entry) => entry.kind === "message")?.txId;
    const firstPromotionTx = sharedStore.txLog.find((entry) => entry.kind === "promotion")?.txId;
    expect(firstMessageTx).toBeDefined();
    expect(firstPromotionTx).toBe(firstMessageTx);

    sharedStore.history.push({
      id: "source-3",
      seq: sharedStore.history.length + 4,
      role: "user",
      text: "empty synthetic answer",
    });
    const empty = await runTurn("", false, undefined, [], "fyi", {
      trigger: "user",
      prompt: "empty synthetic answer",
      sourceMessageId: "source-3",
      runtimeFactory: createRuntime,
      finalizeWithDatabase: true,
      nativeStateStore,
      historyStore: sharedStore,
      runId: "run-3",
      disabledBuiltinTools: builtinAgentTools
        .map((tool) => tool.name)
        .filter((name) => name !== "write_file"),
    });
    expect(empty.finalizeRun.mock.calls[0]?.[0].blocks).toContainEqual({
      kind: "text",
      text: "No response. Try again.",
    });
    expect(empty.finalizeRun.mock.calls[0]?.[0].nativeConversationCandidate).toBeUndefined();
    expect(nativeStateStore.row?.ciphertext).toBeNull();
  });
});
