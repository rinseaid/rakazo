import { createHash } from "node:crypto";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt } from "@earendil-works/pi-ai";
import type { AgentRunModel, CommandRequest, DuplexProcess } from "@rakazo/adapter-kit";
import { claimNativeConversation, nativeContextDelta } from "@rakazo/db";
import type {
  AccountOperationHostDeps,
  AccountOperationProcess,
} from "./account-operation-host.js";
import { openAccountOperationProcess } from "./account-operation-host.js";
import type { AcpConversationLifecycle } from "./acp-conversation.js";
import { openHostedRunRelay } from "./acp-run-relay.js";
import {
  GOOGLE_ACP_EXPERIMENTAL_INPUT_BYTES,
  googleAcpDurableCursorHistory,
  googleAcpModel,
  prepareGoogleAcpInput,
  validateGoogleAcpProfile,
} from "./google-acp-provider.js";
import { createGoogleAcpToolGate } from "./google-acp-tool-gate.js";
import { emitNativeConversationCandidate } from "./native-conversation-candidate.js";
import type { HostedAcpProviderOptions } from "./pi-acp-provider.js";
import { AcpProviderError, createHostedAcpProvider } from "./pi-acp-provider.js";
import type { PiAgentRuntimeOptions } from "./pi-runtime.js";

// Resource ceiling for server-owned history, not a vendor/model context capacity.
const MAX_PERSISTENT_CALLER_BYTES = 2 * 1024 * 1024;

/** Shared API/worker factory. Native credentials never enter the bot's computer. */
export function createAccountModelProvider(
  deps: AccountOperationHostDeps,
): NonNullable<PiAgentRuntimeOptions["createProvider"]> {
  return (config, scope) => {
    if (config.provider !== "google-antigravity") return undefined;
    const userId = scope.context?.userId;
    const spaceId = scope.context?.spaceId;
    if (!userId || !spaceId || !config.connectionId)
      throw new Error("Native models require an authorized account connection");
    const connectionId = config.connectionId;
    const accountGeneration = config.nativeAuth?.accountGeneration;
    const runLease = scope.context?.runLease;
    const historyGeneration = scope.request.historyCompactionGeneration;
    const persistent =
      scope.agentNamespace === "main" &&
      accountGeneration !== undefined &&
      runLease !== undefined &&
      historyGeneration !== undefined &&
      scope.request.durableNativeHistoryProvenance !== undefined;
    return createRemoteGoogleAcpProvider(
      config,
      async () => {
        scope.signal.throwIfAborted();
        const connection = await deps.prisma.userModelCredential.findFirst({
          where: {
            id: connectionId,
            userId,
            provider: config.provider,
            ...(accountGeneration !== undefined ? { secretId: accountGeneration } : {}),
          },
          select: { id: true },
        });
        if (!connection) throw new Error("Native account connection is unavailable");
        return openAccountOperationProcess(deps, {
          actor: { userId, spaceId },
          operationId: scope.request.runId,
          operation: "model",
          signal: scope.signal,
        });
      },
      persistent
        ? async (process, input) => {
            if (!input.context) return undefined;
            const provenance = scope.request.durableNativeHistoryProvenance;
            if (!provenance) return undefined;
            const hostProcess = process as AccountOperationProcess;
            const runtimeIdentity = hostProcess.runtimeIdentity;
            // Compatibility with older hosts is fresh-only, never a guessed image binding.
            if (!runtimeIdentity) return undefined;
            if (runtimeIdentity.length > 1024)
              throw new Error("Invalid private host runtime identity");
            const lease = hostProcess.lease;
            if (
              !lease ||
              lease.userId !== userId ||
              lease.spaceId !== spaceId ||
              lease.operationId !== scope.request.runId
            )
              throw new Error("Native conversation private host ownership is unavailable");
            const cursorHistory = googleAcpDurableCursorHistory(input.context, provenance);
            if (!cursorHistory) return undefined;
            const canonical = cursorHistory.map((message) => JSON.stringify(message));
            const host = deps.sandbox.describe();
            const contextBoundary = createHash("sha256")
              .update(
                JSON.stringify([
                  "google-native-context-v1",
                  getCurrentSystemPrompt(input.context.messages),
                  input.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  })),
                  scope.request.contextStrategy ?? null,
                  config.thinkingLevel ?? null,
                  config.contextWindow ?? null,
                  config.maxTokens ?? null,
                ]),
              )
              .digest("hex");
            const claim = await claimNativeConversation(
              deps.prisma,
              {
                userId,
                spaceId,
                threadId: scope.request.threadId,
                botId: scope.request.botId,
                helperNamespace: "main",
                provider: config.provider,
                credentialId: connectionId,
                accountGeneration: accountGeneration!,
                modelId: config.id,
                // Update with the pinned image/runtime package; never derive this from a vendor model label.
                runtimeVersion:
                  "antigravity-acp/1.4.3/0634ce5306ba92c932945455e7a83fda78e2d99c33fa8aa6ee0566206a382714",
                hostBoundary: JSON.stringify([
                  "private-account-host-v1",
                  runtimeIdentity,
                  host.id,
                  host.contractVersion,
                  host.adapterVersion,
                ]),
                historyGeneration: historyGeneration!,
                contextBoundary,
              },
              {
                runId: scope.request.runId,
                leaseOwner: runLease!.owner,
                leaseFence: runLease!.fence,
                hostId: lease.id,
              },
            );
            const saved = claim.snapshot;
            const delta = saved ? nativeContextDelta(canonical, saved.cursor) : undefined;
            const restore =
              saved && delta && delta.length > 0
                ? {
                    version: 1 as const,
                    sessionId: saved.sessionId,
                    data: Buffer.from(saved.bytes).toString("base64"),
                  }
                : undefined;
            let seen = 0;
            const promptContext = restore
              ? {
                  ...input.context,
                  messages: input.context.messages.filter(
                    (message) => message.role === "system" || seen++ >= saved!.cursor.count,
                  ),
                }
              : input.context;
            let textBytes = 0;
            let capture = true;
            return {
              promptContext,
              observeText(chunk) {
                if (!capture) return;
                const chunkBytes = Buffer.byteLength(chunk);
                if (textBytes + chunkBytes > GOOGLE_ACP_EXPERIMENTAL_INPUT_BYTES) {
                  capture = false;
                  return;
                }
                textBytes += chunkBytes;
              },
              conversation: {
                restore,
                async offerCandidate(state) {
                  // This transfers a run-scoped candidate in memory. The executor binds
                  // its cursor to the logical history committed for this run.
                  if (!capture) return;
                  const pending = claim.prepareCompleted({
                    sessionId: state.sessionId,
                    bytes: Buffer.from(state.data, "base64"),
                  });
                  emitNativeConversationCandidate(scope.request, {
                    provider: config.provider,
                    modelId: config.id,
                    sourceMessageId: provenance.sourceMessageId,
                    canonicalPrefix: canonical,
                    pending,
                  });
                },
              },
            };
          }
        : undefined,
    );
  };
}

/** Server-only lifecycle; context deltas and cursors never come from the native runtime. */
export interface GoogleAcpConversationHooks {
  conversation: AcpConversationLifecycle;
  promptContext?: TranscriptContext;
  observeText?(text: string): void;
}

/** Server-side composition. Never starts a local vendor process or exports secrets as argv. */
export function createRemoteGoogleAcpProvider(
  config: AgentRunModel,
  openProcess: ((request: CommandRequest) => Promise<DuplexProcess>) | undefined,
  prepareConversation?: (
    process: DuplexProcess,
    input: Parameters<HostedAcpProviderOptions["open"]>[0],
  ) => Promise<GoogleAcpConversationHooks | undefined>,
) {
  if (
    config.provider !== "google-antigravity" ||
    config.nativeAuth?.provider !== config.provider ||
    config.apiKey ||
    config.oauth
  )
    throw new Error("Google ACP requires its scoped native account");
  if (!openProcess) throw new Error("This runtime has no isolated account process capability");
  const native = config.nativeAuth;
  const profile = validateGoogleAcpProfile(native.profile);
  const model = googleAcpModel(config);
  return createHostedAcpProvider({
    id: model.provider,
    name: "Google Antigravity",
    models: [model],
    auth: {
      apiKey: {
        name: "Native Google account",
        resolve: async () => ({ auth: {}, source: "scoped native account" }),
      },
    },
    open: async (input) => {
      input.signal.throwIfAborted();
      // Persistent main candidates need the actual host image before a cached prefix can
      // be trusted. Bound their full caller envelope here, then validate the selected
      // delta before helper initialization. Helpers/stateless calls retain the early cap.
      const gate = createGoogleAcpToolGate(
        "rakazo",
        input.tools.map((tool) => tool.name),
        ["list_resources", "read_resource"],
      );
      const projectedTools = input.tools.map((tool) => ({
        ...tool,
        name: gate.project(tool.name),
      }));
      if (input.context) {
        if (prepareConversation) {
          if (
            Buffer.byteLength(JSON.stringify({ context: input.context, tools: input.tools })) >
            MAX_PERSISTENT_CALLER_BYTES
          )
            throw new AcpProviderError("context_limit");
        } else {
          prepareGoogleAcpInput(input.context, projectedTools);
        }
      }
      const process = await openProcess({
        argv: ["/usr/local/bin/rakazo-acp-host"],
        timeoutMs: 10 * 60_000,
      });
      try {
        input.signal.throwIfAborted();
        const hooks = await prepareConversation?.(process, input);
        input.signal.throwIfAborted();
        // A missing/mismatched cache is fresh-only: never truncate oversized full history
        // or transmit it to the helper. This fixed cap also counts current system/tools.
        const selectedContext = hooks?.promptContext ?? input.context;
        if (selectedContext) prepareGoogleAcpInput(selectedContext, projectedTools);
        const run = await openHostedRunRelay(
          process,
          input,
          native.persist,
          {
            provider: config.provider,
            id: config.id,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            ...(config.thinkingLevel ? { thinkingLevel: config.thinkingLevel } : {}),
            profile,
          },
          hooks?.conversation,
        );
        if (!hooks) return run;
        return {
          close: () => run.close(),
          prompt: (context, update, signal) =>
            run.prompt(
              hooks.promptContext ?? context,
              (text) => {
                hooks.observeText?.(text);
                update(text);
              },
              signal,
            ),
        };
      } catch (error) {
        await process.close().catch(() => undefined);
        throw error;
      }
    },
  });
}

export { serveGoogleAcpRun } from "./google-acp-host.js";
