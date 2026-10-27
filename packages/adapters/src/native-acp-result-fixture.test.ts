import { describe, expect, it } from "vitest";
import {
  inspectResultResponses,
  RESULT_SIZES,
  resultEnvelopePayload,
  resultPayload,
} from "./native-acp-result-fixture.js";

const response = (output: string) => [
  { role: "user", parts: [{ functionResponse: { name: "fixture", response: { output } } }] },
];
describe("bounded synthetic tool-result preservation", () => {
  it.each(RESULT_SIZES)("generates and verifies exactly %i bytes", (size) => {
    const payload = resultPayload(size);
    expect(Buffer.byteLength(payload)).toBe(size);
    expect(resultPayload(size)).toBe(payload);
    const evidence = inspectResultResponses(
      response(JSON.stringify({ content: [{ type: "text", text: payload }] })),
      payload,
    );
    expect(evidence).toMatchObject({
      expectedBytes: size,
      extractedBytes: size,
      completeMatches: 1,
      begin: true,
      middle: true,
      end: true,
    });
    expect(evidence.extractedSha256).toBe(evidence.expectedSha256);
  });
  it.each([16 * 1024, 32 * 1024])("preserves exact mixed Unicode byte size %i", (size) => {
    const payload = resultPayload(size, true);
    expect(Buffer.byteLength(payload)).toBe(size);
    expect(payload).toContain("aé漢🙂");
    expect(inspectResultResponses(response(payload), payload).completeMatches).toBe(1);
  });
  it.each(["fixture-request", 17])(
    "bounds the complete escaped result envelope for request %s",
    (id) => {
      const generated = resultEnvelopePayload(id);
      expect(generated.serializedBytes).toBe(32768);
      expect(Buffer.byteLength(JSON.stringify(generated.envelope))).toBe(32768);
      expect(generated.envelope.id).toBe(id);
      for (const part of ['"', "\\", "\n", "\r", "\t", "\b", "\f", "\0", "é漢🙂"])
        expect(generated.text).toContain(part);
      const evidence = inspectResultResponses(
        response(JSON.stringify(generated.result, null, 2)),
        generated.text,
      );
      expect(evidence.completeMatches).toBe(1);
      expect(evidence.expectedSha256).toBe(evidence.extractedSha256);
    },
  );
  it("does not mistake a final answer or a truncated tool response for preservation", () => {
    const payload = resultPayload(16 * 1024);
    expect(inspectResultResponses([{ parts: [{ text: payload }] }], payload).completeMatches).toBe(
      0,
    );
    const truncated = inspectResultResponses(response(payload.slice(0, 9000)), payload);
    expect(truncated.begin).toBe(true);
    expect(truncated.middle).toBe(true);
    expect(truncated.end).toBe(false);
    expect(truncated.completeMatches).toBe(0);
  });
  it("requires the complete exact hash, not just all markers", () => {
    const payload = resultPayload(16 * 1024);
    const changed = `${payload.slice(0, 100)}X${payload.slice(101)}`;
    expect(inspectResultResponses(response(changed), payload)).toMatchObject({
      begin: true,
      middle: true,
      end: true,
      completeMatches: 0,
    });
  });
});
