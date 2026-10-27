import { MAX_NATIVE_CONVERSATION_BYTES } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { ACP_CONVERSATION_MAX_BYTES, parseAcpConversationState } from "./acp-conversation.js";

describe("private native conversation wire envelope", () => {
  it("keeps the database and private relay ceilings aligned", () => {
    expect(ACP_CONVERSATION_MAX_BYTES).toBe(MAX_NATIVE_CONVERSATION_BYTES);
    const state = {
      version: 1,
      sessionId: "fixture-session",
      data: Buffer.alloc(ACP_CONVERSATION_MAX_BYTES).toString("base64"),
    };
    expect(parseAcpConversationState(state)).toEqual(state);
  });
  it.each([
    null,
    { version: 1, sessionId: "../escape", data: "YQ==" },
    { version: 1, sessionId: "valid", data: "YQ" },
    { version: 1, sessionId: "valid", data: "YQ==", extra: "ignored-policy" },
    { version: 2, sessionId: "valid", data: "YQ==" },
    { version: 1, sessionId: "valid", data: "" },
  ])("rejects malformed state without reflecting its contents", (state) => {
    expect(() => parseAcpConversationState(state)).toThrow(
      "Invalid private native conversation state",
    );
  });
  it("rejects over-limit raw state without truncating", () => {
    expect(() =>
      parseAcpConversationState({
        version: 1,
        sessionId: "valid",
        data: Buffer.alloc(ACP_CONVERSATION_MAX_BYTES + 1).toString("base64"),
      }),
    ).toThrow();
  });
});
