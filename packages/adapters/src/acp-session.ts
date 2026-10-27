/** ACP transport and execution remain owned by the selected bot computer. */
export interface AcpTransport {
  request(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
  /** Normal end_turn only; unlike close, this must report a proven EOF exit. */
  finishGracefully?(): Promise<{ clean: boolean; stopped: boolean }>;
  close(): Promise<void>;
}

export interface AcpPermissionRequest {
  sessionId: string;
  toolCall: Record<string, unknown>;
  options: Array<{ optionId: string; kind: string }>;
}

export interface AcpSessionUpdate {
  sessionId: string;
  update: Record<string, unknown>;
}

export interface AcpSessionHost {
  /** Must create a scoped transport in the authorized computer, not the API host. */
  connect(
    handlers: {
      update(update: AcpSessionUpdate): void;
      permission(request: AcpPermissionRequest): Promise<unknown>;
    },
    signal?: AbortSignal,
  ): Promise<AcpTransport>;
  /** Host approval is per call. Persistent allow choices are deliberately unsupported. */
  approve?(request: AcpPermissionRequest, signal: AbortSignal): Promise<boolean>;
}

export interface AcpSessionOptions {
  cwd: string;
  modelId: string;
  thinkingLevel?: string;
  /** Provider-verified mode requiring confirmation, not an ACP-standard mode name. */
  confirmationModeId: string;
  /** MCP endpoints must already be scoped and reachable from the selected computer. */
  mcpServers: Array<Record<string, unknown>>;
  permissionTimeoutMs?: number;
  /** Fresh host configuration, resent on load; native state must not supply live endpoints/policy. */
  creationMetadata?: Record<string, unknown>;
  /** Host-validated binding with native storage already restored. Never inferred from history. */
  resumeSessionId?: string;
}

export function isCompletedAcpStopReason(stopReason: string): boolean {
  return ["end_turn", "max_tokens", "max_turn_requests", "refusal"].includes(stopReason);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid ACP response");
  }
  return value as Record<string, unknown>;
}

/**
 * One run owns one session. No global process, ambient credential lookup, or
 * restoration across accounts. Closing it settles approvals before transport teardown.
 */
export class AcpSession {
  private transport?: AcpTransport;
  private sessionId?: string;
  private closed = false;
  private prompting = false;
  private opening = false;
  private finishing = false;
  private completedPrompt = false;
  private imagePromptSupported = false;
  private readonly lifetime = new AbortController();
  private readonly approvals = new Set<AbortController>();
  private onUpdate?: (update: Record<string, unknown>) => void;
  private closePromise?: Promise<void>;
  private finishPromise?: Promise<{ clean: boolean; stopped: boolean }>;

  constructor(
    private readonly host: AcpSessionHost,
    private readonly options: AcpSessionOptions,
  ) {
    const timeout = options.permissionTimeoutMs ?? 120_000;
    if (!Number.isSafeInteger(timeout) || timeout <= 0)
      throw new Error("Invalid ACP permission timeout");
    if (
      options.resumeSessionId !== undefined &&
      (!options.resumeSessionId.trim() || options.resumeSessionId.length > 1024)
    )
      throw new Error("Invalid ACP session id");
  }

  /** Available only after successful model/mode negotiation. Not a persistence mechanism. */
  get id(): string | undefined {
    return !this.closed && !this.opening ? this.sessionId : undefined;
  }

  get supportsImagePrompt(): boolean {
    return this.imagePromptSupported;
  }

  async open(signal?: AbortSignal): Promise<void> {
    if (this.closed || this.opening || this.transport) throw new Error("ACP session is not new");
    this.opening = true;
    const scopedSignal = this.signal(signal);
    try {
      scopedSignal.throwIfAborted();
      const transport = await this.host.connect(
        {
          update: (notification) => {
            if (this.closed || notification.sessionId !== this.sessionId) return;
            const update = notification.update;
            const changedMode =
              update.sessionUpdate === "current_mode_update" &&
              update.currentModeId !== this.options.confirmationModeId;
            const changedConfig =
              update.sessionUpdate === "config_option_update" &&
              Array.isArray(update.configOptions) &&
              update.configOptions.some((item) => {
                const option = record(item);
                return (
                  option.category === "mode" &&
                  option.currentValue !== this.options.confirmationModeId
                );
              });
            if (changedMode || changedConfig) {
              void this.close().catch(() => undefined);
              return;
            }
            if (this.prompting) this.onUpdate?.(update);
          },
          permission: (request) => this.permission(request),
        },
        scopedSignal,
      );
      // connect can finish after cancellation. Never leave that late process alive.
      if (scopedSignal.aborted || this.closed) {
        await transport.close();
        scopedSignal.throwIfAborted();
        throw new Error("ACP session closed");
      }
      this.transport = transport;
      const initialized = record(
        await transport.request(
          "initialize",
          {
            protocolVersion: 1,
            clientCapabilities: {},
            clientInfo: { name: "rakazo", version: "0.1.0" },
          },
          scopedSignal,
        ),
      );
      if (initialized.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
      const agentCapabilities =
        initialized.agentCapabilities && typeof initialized.agentCapabilities === "object"
          ? record(initialized.agentCapabilities)
          : {};
      const promptCapabilities = agentCapabilities.promptCapabilities;
      this.imagePromptSupported =
        promptCapabilities !== null &&
        typeof promptCapabilities === "object" &&
        !Array.isArray(promptCapabilities) &&
        (promptCapabilities as Record<string, unknown>).image === true;
      if (this.options.mcpServers.length) {
        if (record(agentCapabilities.mcpCapabilities).http !== true)
          throw new Error("ACP agent cannot use the host tool bridge");
      }
      const resume = this.options.resumeSessionId;
      if (resume && agentCapabilities.loadSession !== true)
        throw new Error("ACP agent cannot restore sessions");
      const session = record(
        await transport.request(
          resume ? "session/load" : "session/new",
          {
            cwd: this.options.cwd,
            mcpServers: this.options.mcpServers,
            ...(resume ? { sessionId: resume } : {}),
            ...(this.options.creationMetadata ? { _meta: this.options.creationMetadata } : {}),
          },
          scopedSignal,
        ),
      );
      if (!resume && (typeof session.sessionId !== "string" || !session.sessionId))
        throw new Error("Missing ACP session id");
      this.sessionId = resume ?? (session.sessionId as string);
      // Require confirmation mode; never silently inherit an agent's unrestricted default.
      await this.select(session, "mode", this.options.confirmationModeId, scopedSignal);
      await this.select(session, "model", this.options.modelId, scopedSignal);
      if (this.options.thinkingLevel)
        await this.select(session, "thought_level", this.options.thinkingLevel, scopedSignal);
      scopedSignal.throwIfAborted();
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      this.opening = false;
    }
  }

  async prompt(
    content: Array<Record<string, unknown>>,
    onUpdate: (update: Record<string, unknown>) => void,
    signal?: AbortSignal,
  ): Promise<string> {
    if (this.closed || !this.transport || !this.sessionId || this.opening || this.prompting) {
      throw new Error("ACP session is not ready");
    }
    const scopedSignal = this.signal(signal);
    scopedSignal.throwIfAborted();
    this.prompting = true;
    this.onUpdate = onUpdate;
    const cancel = () => {
      // Cancel is best effort. Teardown is authoritative even on older servers.
      void this.transport
        ?.notify("session/cancel", { sessionId: this.sessionId })
        .catch(() => undefined);
      void this.close().catch(() => undefined);
    };
    scopedSignal.addEventListener("abort", cancel, { once: true });
    try {
      const result = record(
        await this.transport.request(
          "session/prompt",
          { sessionId: this.sessionId, prompt: content },
          scopedSignal,
        ),
      );
      scopedSignal.throwIfAborted();
      if (typeof result.stopReason !== "string") throw new Error("Missing ACP stop reason");
      this.completedPrompt = isCompletedAcpStopReason(result.stopReason) && !scopedSignal.aborted;
      return result.stopReason;
    } catch (error) {
      await this.close();
      throw error;
    } finally {
      scopedSignal.removeEventListener("abort", cancel);
      this.prompting = false;
      this.onUpdate = undefined;
      for (const approval of this.approvals) approval.abort();
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.resolve().then(() => this.transport?.close());
    this.lifetime.abort();
    for (const approval of this.approvals) approval.abort();
    return this.closePromise;
  }

  /** Gracefully end only a completed turn; callers must retain the clean-exit result. */
  finishGracefully(): Promise<{ clean: boolean; stopped: boolean }> {
    if (this.finishPromise) return this.finishPromise;
    if (!this.completedPrompt || this.prompting || this.closed || this.finishing || !this.transport)
      return Promise.resolve({ clean: false, stopped: false });
    this.finishing = true;
    const transport = this.transport;
    this.finishPromise = (async () => {
      try {
        if (!transport.finishGracefully) {
          await this.close();
          return { clean: false, stopped: true };
        }
        const result = await transport.finishGracefully();
        this.closed = true;
        this.lifetime.abort();
        for (const approval of this.approvals) approval.abort();
        return result;
      } catch (error) {
        await this.close().catch(() => undefined);
        throw error;
      } finally {
        this.finishing = false;
      }
    })();
    return this.finishPromise;
  }

  private async select(
    session: Record<string, unknown>,
    category: "mode" | "model" | "thought_level",
    value: string,
    signal: AbortSignal,
  ): Promise<void> {
    const config = Array.isArray(session.configOptions)
      ? session.configOptions.map(record).find((entry) => entry.category === category)
      : undefined;
    if (config) {
      const contains = (entries: unknown): boolean =>
        Array.isArray(entries) &&
        entries.some((entry) => {
          const option = record(entry);
          return option.value === value || contains(option.options);
        });
      if (typeof config.id !== "string" || !contains(config.options))
        throw new Error(`ACP ${category} is unavailable`);
      const result = record(
        await this.transport!.request(
          "session/set_config_option",
          { sessionId: this.sessionId, configId: config.id, value },
          signal,
        ),
      );
      const confirmed =
        Array.isArray(result.configOptions) &&
        result.configOptions
          .map(record)
          .some((entry) => entry.id === config.id && entry.currentValue === value);
      if (!confirmed) throw new Error(`ACP ${category} selection was not confirmed`);
      session.configOptions = result.configOptions;
      return;
    }
    if (category === "thought_level") throw new Error("ACP thought level is unavailable");
    const state = record(session[category === "mode" ? "modes" : "models"]);
    const available = state[category === "mode" ? "availableModes" : "availableModels"];
    const idField = category === "mode" ? "id" : "modelId";
    if (!Array.isArray(available) || !available.some((entry) => record(entry)[idField] === value))
      throw new Error(`ACP ${category} is unavailable`);
    await this.transport!.request(
      category === "mode" ? "session/set_mode" : "session/set_model",
      { sessionId: this.sessionId, [category === "mode" ? "modeId" : "modelId"]: value },
      signal,
    );
  }

  private signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([this.lifetime.signal, signal]) : this.lifetime.signal;
  }

  private async permission(request: AcpPermissionRequest): Promise<unknown> {
    const denied = { outcome: { outcome: "cancelled" } };
    if (
      this.closed ||
      this.finishing ||
      !this.prompting ||
      request.sessionId !== this.sessionId ||
      !this.host.approve
    )
      return denied;
    const once = request.options.filter((entry) => entry.kind === "allow_once");
    // Multiple allow_once choices can be an agent question, not a yes/no permission.
    if (
      once.length !== 1 ||
      new Set(request.options.map((entry) => entry.optionId)).size !== request.options.length
    )
      return denied;
    const option = once[0]!;
    const controller = new AbortController();
    this.approvals.add(controller);
    const signal = AbortSignal.any([this.lifetime.signal, controller.signal]);
    let abort: (() => void) | undefined;
    const timer = setTimeout(() => controller.abort(), this.options.permissionTimeoutMs ?? 120_000);
    try {
      const approved = await Promise.race([
        Promise.resolve().then(() => this.host.approve?.(request, signal)),
        new Promise<boolean>((resolve) => {
          abort = () => resolve(false);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) resolve(false);
        }),
      ]);
      return approved === true && !signal.aborted && !this.closed && this.prompting
        ? { outcome: { outcome: "selected", optionId: option.optionId } }
        : denied;
    } catch {
      return denied;
    } finally {
      clearTimeout(timer);
      if (abort) signal.removeEventListener("abort", abort);
      controller.abort();
      this.approvals.delete(controller);
    }
  }
}
