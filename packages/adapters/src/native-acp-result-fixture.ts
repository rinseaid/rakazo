/** Deterministic bounded synthetic tool-output evidence; never production input handling. */
import { createHash } from "node:crypto";

export const RESULT_SIZES = [16 * 1024, 32 * 1024, 128 * 1024, 512 * 1024] as const;
const BEGIN = "RKZ_RESULT_BEGIN_7b092d";
const MIDDLE = "RKZ_RESULT_MIDDLE_7b092d";
const END = "RKZ_RESULT_END_7b092d";
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
export function resultPayload(bytes: number, unicode = false): string {
  if (!RESULT_SIZES.some((size) => size === bytes)) throw new Error("Unsupported fixture size");
  if (unicode) {
    const fill = (length: number) =>
      "aé漢🙂".repeat(Math.floor(length / 10)) + "x".repeat(length % 10);
    const middle = Math.floor(bytes / 2);
    return (
      BEGIN +
      fill(middle - BEGIN.length) +
      MIDDLE +
      fill(bytes - middle - MIDDLE.length - END.length) +
      END
    );
  }
  const blocks: string[] = [];
  for (let i = 0; blocks.length * 64 < bytes; i++) blocks.push(hash(`fixture-result-block-${i}`));
  const text = blocks.join("").slice(0, bytes);
  const middle = Math.floor(bytes / 2);
  return (
    BEGIN +
    text.slice(BEGIN.length, middle) +
    MIDDLE +
    text.slice(middle + MIDDLE.length, bytes - END.length) +
    END
  );
}
/** Account for the actual request id and every JSON escape in the result envelope. */
export function resultEnvelopePayload(requestId: string | number, limit = 32 * 1024) {
  if (limit !== 32 * 1024 || Buffer.byteLength(JSON.stringify(requestId)) > 1024)
    throw new Error("Fixture envelope bound");
  const pattern = 'q"\\\n\r\t\b\f\0é漢🙂';
  const result = (text: string) => ({ isError: false, content: [{ type: "text" as const, text }] });
  const wire = (text: string) => ({ jsonrpc: "2.0" as const, id: requestId, result: result(text) });
  const textFor = (count: number) =>
    BEGIN +
    pattern.repeat(Math.floor(count / 2)) +
    MIDDLE +
    pattern.repeat(count - Math.floor(count / 2)) +
    END;
  let low = 0;
  let high = limit;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(wire(textFor(middle)))) <= limit) low = middle;
    else high = middle - 1;
  }
  let text = textFor(low);
  const remainder = limit - Buffer.byteLength(JSON.stringify(wire(text)));
  if (remainder < 0) throw new Error("Fixture envelope cannot fit");
  text = text.slice(0, -END.length) + "x".repeat(remainder) + END;
  return {
    text,
    result: result(text),
    envelope: wire(text),
    serializedBytes: Buffer.byteLength(JSON.stringify(wire(text))),
  };
}

export function inspectResultResponses(contents: unknown, payload: string) {
  const evidence = {
    expectedBytes: Buffer.byteLength(payload),
    expectedSha256: hash(payload),
    truncationNotice: false,
    functionResponses: 0,
    completeMatches: 0,
    begin: false,
    middle: false,
    end: false,
    largestStringBytes: 0,
    extractedBytes: 0,
    extractedSha256: "",
  };
  const record = (value: unknown): Record<string, unknown> =>
    value !== null && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  let visited = 0;
  function inspect(value: unknown, depth = 0) {
    if (++visited > 10000 || depth > 16) throw new Error("Fixture structure bound");
    if (typeof value === "string") {
      const bytes = Buffer.byteLength(value);
      if (bytes > 2 * 1024 * 1024) throw new Error("Fixture string bound");
      evidence.largestStringBytes = Math.max(evidence.largestStringBytes, bytes);
      // Native MCP responses may wrap their content as a JSON string. Decode
      // that representation before comparing text with escaped/control bytes.
      const trimmed = value.trim();
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        let decoded: unknown;
        try {
          decoded = JSON.parse(trimmed);
        } catch {
          decoded = undefined;
        }
        if (decoded !== undefined) {
          inspect(decoded, depth + 1);
          return;
        }
      }
      evidence.truncationNotice ||= /truncat(?:ed|ion)/i.test(value);
      evidence.begin ||= value.includes(BEGIN);
      evidence.middle ||= value.includes(MIDDLE);
      evidence.end ||= value.includes(END);
      const start = value.indexOf(BEGIN);
      const finish = start < 0 ? -1 : value.indexOf(END, start);
      if (start >= 0 && finish >= start) {
        const extracted = value.slice(start, finish + END.length);
        evidence.extractedBytes = Buffer.byteLength(extracted);
        evidence.extractedSha256 = hash(extracted);
        if (
          evidence.extractedBytes === evidence.expectedBytes &&
          evidence.extractedSha256 === evidence.expectedSha256
        )
          evidence.completeMatches++;
      }
    } else if (Array.isArray(value)) for (const entry of value) inspect(entry, depth + 1);
    else for (const entry of Object.values(record(value))) inspect(entry, depth + 1);
  }
  for (const content of Array.isArray(contents) ? contents : []) {
    const parts = record(content).parts;
    for (const part of Array.isArray(parts) ? parts : []) {
      const response = record(part).functionResponse ?? record(part).function_response;
      if (response !== undefined) {
        evidence.functionResponses++;
        inspect(response);
      }
    }
  }
  return evidence;
}
