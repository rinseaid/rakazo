/** Offline-only conformance fixture helpers; never imported by production hosts. */
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { createAcpToolServer } from "./acp-tool-server.js";
import { createGoogleAcpToolGate } from "./google-acp-tool-gate.js";

export const RESERVED = createGoogleAcpToolGate(
  "rakazo",
  ["fixture_original"],
  ["list_resources", "read_resource"],
).project("fixture_original");
export const OTHER = "fixture_counter_other";
export const RESOURCE = "fixture://memory/value";
export const CASES = [
  "fixed-result-inline-envelope-32k",
  "fixed-result-inline-graceful-restore",
  "fixed-result-inline-32k",
  "fixed-result-inline-unicode-16k",
  "fixed-result-inline-unicode-32k",
  "fixed-result-inline-16k",
  "fixed-result-inline-128k",
  "fixed-result-inline-512k",
  "fixed-result-inline-restore",
  "fixed-result-16k",
  "fixed-result-128k",
  "fixed-result-512k",
  "fixed-result-restore",
  "fixed-load-allow",
  "fixed-load-other",
  "fixed-load-pi-deny",
  "fixed-allow",
  "fixed-other",
  "fixed-pi-deny",
  "baseline",
  "pi-deny",
  "deny",
  "allow",
  "other",
  "list_resources",
  "read_resource",
  "nonzero",
  "malformed",
] as const;
export type HookCase = (typeof CASES)[number];
export function targetFor(test: HookCase): string {
  return test === "other" || test === "fixed-other" || test === "fixed-load-other"
    ? OTHER
    : test === "list_resources" || test === "read_resource"
      ? test
      : RESERVED;
}
export function expectedEffects(test: HookCase): number {
  return test.startsWith("fixed-result-") ||
    test === "baseline" ||
    test === "allow" ||
    test === "fixed-allow" ||
    test === "fixed-load-allow"
    ? 1
    : 0;
}
export function hookConfiguration(command: string) {
  return {
    "fixture-gate": {
      enabled: true,
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command, timeout: 5 }] }],
    },
  };
}
// Fixture script is fixed provider-owned code. Only synthetic canonical names/counts
// reach its loopback observer; it never emits arguments, headers, paths or tokens.
export function hookProgram(test: HookCase, observer: string, fixedProgramPath?: string): string {
  if (test.startsWith("fixed-") && !fixedProgramPath)
    throw new Error("Fixed program path required");
  return `import http from 'node:http';
import {spawn} from 'node:child_process';
let input='';
try {
 for await (const chunk of process.stdin) { input+=chunk; if(input.length>1048576) throw Error(); }
 const data=JSON.parse(input);
 const name=data?.toolCall?.name;
 const known=${JSON.stringify([RESERVED, OTHER, "list_resources", "read_resource"])};
 const observed=known.includes(name)?name:'unknown';
 await new Promise((resolve,reject)=>{const req=http.request(${JSON.stringify(observer)}, {method:'POST',headers:{'content-type':'application/json'},timeout:2000},res=>{res.resume();res.on('end',()=>res.statusCode===200?resolve():reject(Error()));});req.on('error',reject);req.on('timeout',()=>req.destroy(Error()));req.end(JSON.stringify({name:observed}));});
 ${test.startsWith("fixed-") ? `await new Promise((resolve,reject)=>{const child=spawn(process.execPath,[${JSON.stringify(fixedProgramPath)},${JSON.stringify(JSON.stringify([RESERVED]))}],{stdio:['pipe','inherit','inherit']});child.on('error',reject);child.on('close',code=>{process.exitCode=code??1;resolve();});child.stdin.on('error',reject);child.stdin.end(input);});` : test === "nonzero" ? "process.exitCode=1;" : test === "malformed" ? "process.stdout.write('{');" : `process.stdout.write(JSON.stringify({allowTool:${test === "deny" ? "false" : `name===${JSON.stringify(RESERVED)}`},denyReason:'Synthetic fixture gate'}));`}
} catch { process.exitCode=1; }
`;
}
export function fixtureServer(
  counts: {
    dispatches: number;
    effects: number;
    resourceLists: number;
    resourceReads: number;
  },
  authorizeEffect: () => boolean = () => true,
  resultText = "fixture-counter-result",
  dynamicResultText?: (requestId: string | number) => string,
) {
  const server = createAcpToolServer(
    [RESERVED, OTHER].map((name) => ({
      name,
      description: `Synthetic in-memory counter ${name}.`,
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    })),
    async (name, args) => {
      counts.dispatches++;
      if (
        ![RESERVED, OTHER].includes(name) ||
        args.value !== "fixture" ||
        Object.keys(args).length !== 1
      )
        throw new Error("fixture input mismatch");
      if (!authorizeEffect())
        return {
          role: "toolResult",
          toolCallId: "fixture",
          toolName: name,
          content: [{ type: "text", text: "Denied by synthetic Pi approval" }],
          isError: true,
          timestamp: 0,
        };
      counts.effects++;
      return {
        role: "toolResult",
        toolCallId: "fixture",
        toolName: name,
        content: [{ type: "text", text: resultText }],
        isError: false,
        timestamp: 0,
      };
    },
  );
  if (dynamicResultText) {
    // Fixture-only override: obtain the actual request id before sizing text.
    // The authenticated listener reserves the id; release its unstarted slot.
    server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      try {
        counts.dispatches++;
        if (
          request.params.name !== RESERVED ||
          request.params.arguments?.value !== "fixture" ||
          Object.keys(request.params.arguments ?? {}).length !== 1 ||
          !authorizeEffect()
        )
          throw new Error("Invalid representation fixture call");
        const text = dynamicResultText(extra.requestId);
        counts.effects++;
        return { isError: false, content: [{ type: "text" as const, text }] };
      } finally {
        server.releaseUnstartedToolRequest(extra.requestId);
      }
    });
  }
  server.registerCapabilities({ resources: {} });
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    counts.resourceLists++;
    return { resources: [{ uri: RESOURCE, name: "In-memory fixture", mimeType: "text/plain" }] };
  });
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    counts.resourceReads++;
    if (request.params.uri !== RESOURCE) throw new Error("unknown fixture resource");
    return { contents: [{ uri: RESOURCE, mimeType: "text/plain", text: "fixture-memory" }] };
  });
  return server;
}
