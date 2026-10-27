import { ThinkingLevelSchema } from "@rakazo/contracts";
import type { AcpSessionHost } from "./acp-session.js";

/** Only identity/display metadata: ACP does not establish token limits or input capabilities. */
export interface AcpDiscoveredModel {
  id: string;
  name: string;
  description?: string;
  thinkingLevels?: string[];
}

export type AcpModelDiscovery =
  | {
      models: AcpDiscoveredModel[];
      currentModelId: string;
      selection:
        | { method: "session/set_config_option"; configId: string }
        | {
            method: "session/set_model";
          };
    }
  | { models: []; currentModelId?: never; selection?: never };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid ACP model metadata");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid ACP model metadata");
  return value;
}

/**
 * Prefer the standard model selector; never merge a stale legacy catalog into it.
 * Missing model metadata is an empty catalog, not permission to invent model IDs.
 * The unknown boundary also covers older agents' legacy `models` extension.
 */
export function readAcpModels(metadata: unknown): AcpModelDiscovery {
  const session = object(metadata);
  const models: AcpDiscoveredModel[] = [];
  const ids = new Set<string>();
  const add = (entry: Record<string, unknown>, id: unknown) => {
    const model: AcpDiscoveredModel = { id: string(id), name: string(entry.name) };
    if (ids.has(model.id)) throw new Error("Duplicate ACP model choice");
    ids.add(model.id);
    if (entry.description != null) {
      if (typeof entry.description !== "string") throw new Error("Invalid ACP model metadata");
      model.description = entry.description;
    }
    models.push(model);
  };
  let config: Record<string, unknown> | undefined;
  let thoughtLevel: Record<string, unknown> | undefined;
  if (session.configOptions != null) {
    if (!Array.isArray(session.configOptions)) throw new Error("Invalid ACP model metadata");
    for (const value of session.configOptions) {
      const candidate = object(value);
      if (candidate.category === "model") {
        if (config) throw new Error("Ambiguous ACP model selector");
        config = candidate;
      } else if (candidate.category === "thought_level" && !thoughtLevel) {
        thoughtLevel = candidate;
      }
    }
  }
  let currentModelId: string;
  let selection: NonNullable<AcpModelDiscovery["selection"]>;
  if (config) {
    if (config.type !== "select" || !Array.isArray(config.options))
      throw new Error("Invalid ACP model selector");
    selection = { method: "session/set_config_option", configId: string(config.id) };
    currentModelId = string(config.currentValue);
    const groups = new Set<string>();
    let grouped: boolean | undefined;
    for (const value of config.options) {
      const entry = object(value);
      const isGroup = "group" in entry;
      if (grouped !== undefined && grouped !== isGroup)
        throw new Error("Invalid ACP model options");
      grouped = isGroup;
      if (!isGroup) {
        if ("options" in entry) throw new Error("Invalid ACP model options");
        add(entry, entry.value);
        continue;
      }
      const group = string(entry.group);
      string(entry.name);
      if (groups.has(group) || "value" in entry || !Array.isArray(entry.options))
        throw new Error("Invalid ACP model group");
      groups.add(group);
      for (const value of entry.options) {
        const option = object(value);
        if ("group" in option || "options" in option) throw new Error("Invalid ACP model options");
        add(option, option.value);
      }
    }
  } else {
    if (session.models == null) return { models: [] };
    const legacy = object(session.models);
    if (!Array.isArray(legacy.availableModels)) throw new Error("Invalid ACP model metadata");
    for (const value of legacy.availableModels) {
      const entry = object(value);
      add(entry, entry.modelId);
    }
    currentModelId = string(legacy.currentModelId);
    selection = { method: "session/set_model" };
  }
  if (!ids.has(currentModelId)) throw new Error("ACP current model is unavailable");
  const levels = thoughtLevel?.type === "select" ? optionValues(thoughtLevel.options) : [];
  if (levels.length) models.find((model) => model.id === currentModelId)!.thinkingLevels = levels;
  return { models, currentModelId, selection };
}

function optionValues(options: unknown): string[] {
  if (!Array.isArray(options)) return [];
  const levels = new Set<string>();
  for (const value of options) {
    const entry = object(value);
    if (Array.isArray(entry.options)) {
      for (const nested of optionValues(entry.options)) levels.add(nested);
      continue;
    }
    if (typeof entry.value === "string" && ThinkingLevelSchema.safeParse(entry.value).success)
      levels.add(entry.value);
  }
  return [...levels];
}

/**
 * One explicitly scoped computer/account connection, no prompts or tool execution.
 * The caller owns account profile preparation/persistence and host qualification.
 * No global catalog/cache: available choices can differ between accounts and sessions.
 */
export async function discoverAcpModels(
  host: AcpSessionHost,
  options: { cwd: string; creationMetadata?: Record<string, unknown> },
  signal?: AbortSignal,
): Promise<AcpModelDiscovery> {
  signal?.throwIfAborted();
  const transport = await host.connect(
    {
      update: () => {},
      permission: async () => ({ outcome: { outcome: "cancelled" } }),
    },
    signal,
  );
  try {
    signal?.throwIfAborted();
    const initialized = object(
      await transport.request(
        "initialize",
        {
          protocolVersion: 1,
          clientCapabilities: {},
          clientInfo: { name: "rakazo", version: "0.1.0" },
        },
        signal,
      ),
    );
    if (initialized.protocolVersion !== 1) throw new Error("Unsupported ACP protocol version");
    const session = object(
      await transport.request(
        "session/new",
        {
          cwd: options.cwd,
          mcpServers: [],
          ...(options.creationMetadata ? { _meta: options.creationMetadata } : {}),
        },
        signal,
      ),
    );
    // Check identity as well as model metadata before returning a discovery result.
    string(session.sessionId);
    signal?.throwIfAborted();
    return readAcpModels(session);
  } finally {
    await transport.close();
  }
}
