/** Private wire payload. Native DBs can contain old MCP credentials: never log or publish. */
export interface AcpConversationState {
  version: 1;
  sessionId: string;
  data: string;
}
export const ACP_CONVERSATION_MAX_BYTES = 4 * 1024 * 1024;

export function parseAcpConversationState(value: unknown): AcpConversationState {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid private native conversation state");
  const state = value as Record<string, unknown>;
  if (
    Object.keys(state).length !== 3 ||
    state.version !== 1 ||
    typeof state.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(state.sessionId) ||
    typeof state.data !== "string" ||
    !state.data ||
    state.data.length > Math.ceil(ACP_CONVERSATION_MAX_BYTES / 3) * 4
  )
    throw new Error("Invalid private native conversation state");
  const bytes = Buffer.from(state.data, "base64");
  if (bytes.length > ACP_CONVERSATION_MAX_BYTES || bytes.toString("base64") !== state.data)
    throw new Error("Invalid private native conversation state");
  return { version: 1, sessionId: state.sessionId, data: state.data };
}

export interface AcpConversationLifecycle {
  restore?: AcpConversationState;
  /** Host has confirmed end_turn and process exit. Receiver still enforces durable ownership. */
  offerCandidate(state: AcpConversationState): Promise<void>;
}
