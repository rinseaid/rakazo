import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import type {
  AgentRunModel,
  AgentRunRequest,
  AgentRuntimeEvent,
  CommandRequest,
  DuplexProcess,
  NativeModelProfile,
  ProcessEvent,
} from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import * as acpProcess from "./acp-process.js";
import {
  createGoogleAcpProvider,
  createGoogleAcpRun,
  GOOGLE_ACP_EXPERIMENTAL_INPUT_BYTES,
  GOOGLE_ACP_MCP_OUTPUT_BYTES,
  googleAcpModel,
  googleAcpPromptImages,
  isCompletedGoogleAcpStopReason,
  prepareGoogleAcpInput,
  validateGoogleAcpProfile,
} from "./google-acp-provider.js";
import { createRemoteGoogleAcpProvider, serveGoogleAcpRun } from "./google-acp-remote.js";
import { AcpProviderError } from "./pi-acp-provider.js";
import { PiAgentRuntime } from "./pi-runtime.js";

function profile(): NativeModelProfile {
  return {
    version: 1,
    files: [
      {
        path: ".gemini/antigravity-acp/settings.json",
        data: JSON.stringify({ auth: { type: "oauth-personal" } }),
      },
      {
        path: ".gemini/antigravity-acp/acp_token.json",
        data: JSON.stringify({
          refresh_token: "fake-refresh",
          client_id: "fake-client",
          client_secret: "fake-client-secret",
          token_uri: "https://oauth2.googleapis.com/token",
        }),
      },
    ],
  };
}
const agent = `
let endpoint; let mcpSession; let activeSession;
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
async function mcp(method,params,notify=false){
 const headers=Object.fromEntries(endpoint.headers.map(h=>[h.name,h.value]));
 Object.assign(headers,{'Content-Type':'application/json','Accept':'application/json, text/event-stream'});
 if(mcpSession)headers['Mcp-Session-Id']=mcpSession;
 const response=await fetch(endpoint.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(notify?{}:{id:method}),method,params})});
 mcpSession=response.headers.get('mcp-session-id')||mcpSession;
 if(notify)return;
 if(!response.ok)throw new Error('MCP failed');
 return (await response.json()).result;
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 const req=JSON.parse(line);
 try {
  if(req.method==='initialize')send(req.id,{protocolVersion:1,agentCapabilities:{loadSession:true,promptCapabilities:{image:true},mcpCapabilities:{http:true}},authMethods:[]});
  else if(req.method==='session/new'||req.method==='session/load'){
   if(req.params._meta.antigravity.enabledTools.length!==0)throw new Error('Missing tool boundary');
   if(req.params._meta.antigravity.mcpMaxOutputBytes!==1048576)throw new Error('Missing inline output setting');
   if(!req.params._meta.antigravity.eagerMcpServers.includes(req.params.mcpServers[0].name))throw new Error('Missing eager bridge schemas');
   if(!req.params._meta.antigravity.systemPrompt.append.includes('instructions'))throw new Error('Missing instructions');
   endpoint=req.params.mcpServers[0];
   activeSession=req.params.sessionId||'fake-session';
   send(req.id,{sessionId:'fake-session',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]},models:{currentModelId:'fixture',availableModels:[{modelId:'fixture',name:'Fixture'}]}});
  } else if(req.method==='session/set_mode'||req.method==='session/set_model')send(req.id,{});
  else if(req.method==='session/prompt'){
   await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fake-agent',version:'1'}});
   await mcp('notifications/initialized',{},true);
   const result=await mcp('tools/call',{name:'read',arguments:{path:'sample'}});
   if(result.isError)throw new Error('Host denied tool');
   const text=req.params.prompt.some(part=>part.type==='image'&&part.mimeType==='image/png')?'Received image block.':'Completed with host tool.';
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:activeSession,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text}}}})+'\\n');
   send(req.id,{stopReason:'end_turn'});
  }
 }catch(e){send(req.id,{stopReason:'cancelled'});}
});`;

describe("Google ACP full offline composition", () => {
  it("accepts known terminal stop reasons while keeping cancellation unknown", () => {
    expect(isCompletedGoogleAcpStopReason("end_turn")).toBe(true);
    expect(isCompletedGoogleAcpStopReason("max_tokens")).toBe(true);
    expect(isCompletedGoogleAcpStopReason("max_turn_requests")).toBe(true);
    expect(isCompletedGoogleAcpStopReason("refusal")).toBe(true);
    expect(isCompletedGoogleAcpStopReason("cancelled")).toBe(false);
    expect(isCompletedGoogleAcpStopReason("future_reason")).toBe(false);
  });

  it("uses the qualified inline MCP transport ceiling", () => {
    expect(GOOGLE_ACP_MCP_OUTPUT_BYTES).toBe(1024 * 1024);
  });

  it("shares model capability defaults without needing the native account", () => {
    const model = { provider: "google-antigravity", id: "fixture" };
    expect(googleAcpModel(model)).toMatchObject({
      id: "fixture",
      provider: "google-antigravity",
      api: "acp",
      input: ["text", "image"],
      reasoning: false,
      contextWindow: 1_048_576,
      maxTokens: 65_536,
    });
    expect(googleAcpModel({ ...model, contextWindow: 64000, maxTokens: 8000 })).toMatchObject({
      contextWindow: 64000,
      maxTokens: 8000,
    });
  });

  it.each(["local", "remote"])(
    "runs the existing Rakazo loop through %s composition, real subprocess and MCP bridge",
    async (route) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "google-acp-offline-"));
      const execute = vi.fn(async () => ({ text: "sample contents" }));
      const persist = vi.fn(async () => true);
      const model: AgentRunModel = {
        provider: "google-antigravity",
        id: "fixture",
        nativeAuth: { provider: "google-antigravity", profile: profile(), persist },
      };
      const request: AgentRunRequest = {
        botId: "b",
        threadId: "t",
        runId: "google-offline",
        instructions: "test instructions",
        prompt: "Read sample",
        history: [],
        model,
        tools: [
          {
            name: "read",
            description: "Read",
            inputSchema: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
            },
            readOnly: true,
          },
        ],
        executeTool: execute,
      };
      try {
        const computer = {
          executable: process.execPath,
          args: ["-e", agent],
          workspace: parent,
          profileParent: parent,
        };
        const open = async (command: CommandRequest): Promise<DuplexProcess> => {
          expect(command.argv).toEqual(["/usr/local/bin/rakazo-acp-host"]);
          expect(command.env).toBeUndefined();
          const input = new PassThrough();
          const output = new PassThrough();
          const serving = serveGoogleAcpRun(input, output, computer);
          void serving.catch(() => {});
          const remote: DuplexProcess = {
            events: (async function* (): AsyncGenerator<ProcessEvent> {
              for await (const data of output) yield { type: "stdout", data: data.toString() };
            })(),
            write: (data) =>
              new Promise<void>((resolve, reject) => {
                input.write(data, (error) => (error ? reject(error) : resolve()));
              }),
            end: async () => {
              input.end();
            },
            exited: serving.then(
              () => ({ code: 0 }),
              () => ({ code: 1 }),
            ),
            close: async () => {
              input.destroy();
              await serving;
              output.destroy();
            },
          };
          return remote;
        };
        const runtime = new PiAgentRuntime({
          createProvider: (selected) =>
            route === "remote"
              ? createRemoteGoogleAcpProvider(selected, open)
              : createGoogleAcpProvider(selected, computer),
        });
        const events: AgentRuntimeEvent[] = [];
        for await (const event of runtime.run(request)) events.push(event);
        expect(execute).toHaveBeenCalledTimes(1);
        expect(
          events.some(
            (event) => event.type === "text" && event.text.includes("Completed with host tool"),
          ),
        ).toBe(true);
        expect(persist).not.toHaveBeenCalled();
        expect(await readdir(parent)).toEqual([]);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  it.each([
    { mode: "new", image: false },
    { mode: "load", image: false },
    { mode: "new", image: true },
  ] as const)(
    "opens a native $mode run with image=$image and the bounded MCP output setting",
    async ({ mode, image }) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "google-acp-direct-"));
      const persist = vi.fn(async () => true);
      const callTool = vi.fn(
        async (name: string): Promise<ToolResultMessage> => ({
          role: "toolResult",
          toolCallId: "direct-read",
          toolName: name,
          content: [{ type: "text", text: "sample contents" }],
          isError: false,
          timestamp: 1,
        }),
      );
      const signal = new AbortController().signal;
      try {
        const run = await createGoogleAcpRun(
          {
            provider: "google-antigravity",
            id: "fixture",
            nativeAuth: { provider: "google-antigravity", profile: profile(), persist },
          },
          {
            executable: process.execPath,
            args: ["-e", agent],
            workspace: parent,
            profileParent: parent,
          },
          {
            tools: [
              {
                name: "read",
                description: "Read",
                parameters: Type.Object({ path: Type.String() }),
              },
            ],
            callTool,
            signal,
            ...(mode === "load"
              ? {
                  conversation: {
                    restore: {
                      version: 1 as const,
                      sessionId: "fixture-session",
                      data: Buffer.from("synthetic").toString("base64"),
                    },
                    offerCandidate: vi.fn(async () => undefined),
                  },
                }
              : {}),
          },
        );
        const update = vi.fn();
        try {
          await run.prompt(
            normalizeContext({
              systemPrompt: "test instructions",
              messages: [
                {
                  role: "user",
                  content: image
                    ? [
                        { type: "text", text: "Read sample" },
                        {
                          type: "image",
                          data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
                          mimeType: "image/gif",
                        },
                      ]
                    : "Read sample",
                  timestamp: 1,
                },
              ],
            }),
            update,
            signal,
          );
          expect(callTool).toHaveBeenCalledExactlyOnceWith("read", { path: "sample" });
          expect(update).toHaveBeenCalledExactlyOnceWith(
            image ? "Received image block." : "Completed with host tool.",
          );
        } finally {
          await Promise.all([run.close(), run.close()]);
        }
        expect(persist).not.toHaveBeenCalled();
        expect(await readdir(parent)).toEqual([]);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    },
  );

  it("stops after an oversized native tool result without redispatch or provider fallback", async () => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "google-acp-output-limit-"));
    const overflowAgent = agent
      .replace("name:'read',arguments:{path:'sample'}", "name:'list_fleet',arguments:{}")
      .replace(
        "if(result.isError)throw new Error('Host denied tool');",
        "if(result.isError){await mcp('tools/call',{name:'list_fleet',arguments:{}});throw new Error('Host denied tool');}",
      );
    const execute = vi.fn(async () => ({ text: "x".repeat(40 * 1024) }));
    const selectedProviders: string[] = [];
    const model: AgentRunModel = {
      provider: "google-antigravity",
      id: "fixture",
      nativeAuth: { provider: "google-antigravity", profile: profile(), persist: async () => true },
    };
    const request: AgentRunRequest = {
      botId: "b",
      threadId: "t",
      runId: "google-output-limit",
      instructions: "test instructions",
      prompt: "List the fleet",
      history: [],
      model,
      fallbackModels: [{ provider: "fallback", id: "fixture-fallback" }],
      resolveFallbackModel: vi.fn(async () => ({ provider: "fallback", id: "fixture-fallback" })),
      tools: [
        {
          name: "list_fleet",
          description: "List fleet",
          inputSchema: { type: "object", properties: {} },
          readOnly: false,
        },
      ],
      executeTool: execute,
    };
    try {
      const runtime = new PiAgentRuntime({
        createProvider: (selected) => {
          selectedProviders.push(selected.provider);
          if (selected.provider !== "google-antigravity") throw new Error("unexpected fallback");
          return createGoogleAcpProvider(selected, {
            executable: process.execPath,
            args: ["-e", overflowAgent],
            workspace: parent,
            profileParent: parent,
          });
        },
      });
      const events: AgentRuntimeEvent[] = [];
      await expect(async () => {
        for await (const event of runtime.run(request)) events.push(event);
      }).rejects.toThrow("ACP execution outcome is unknown; do not retry automatically");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(selectedProviders).toEqual(["google-antigravity"]);
      expect(events.some((event) => event.type === "tool" && event.name === "list_fleet")).toBe(
        true,
      );
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  it("does not let a corrupted profile redirect the refresh token to another service", () => {
    const corrupted = profile();
    const token = JSON.parse(corrupted.files[1]!.data);
    token.token_uri = "https://attacker.invalid/token";
    corrupted.files[1]!.data = JSON.stringify(token);
    expect(() => validateGoogleAcpProfile(corrupted)).toThrow("invalid");
  });

  it("rejects unrelated credential files and paid API authentication", () => {
    const extra = profile();
    extra.files.push({ path: "another-account/token", data: "fixture" });
    expect(() => validateGoogleAcpProfile(extra)).toThrow();
    const paid = profile();
    paid.files[0]!.data = JSON.stringify({ auth: { type: "gemini-api-key" } });
    expect(() => validateGoogleAcpProfile(paid)).toThrow();
  });
});

describe("Google ACP experimental input preflight", () => {
  const limit = GOOGLE_ACP_EXPERIMENTAL_INPUT_BYTES;
  const context = (content: string, systemPrompt = "") =>
    normalizeContext({
      systemPrompt,
      messages: [{ role: "user" as const, content, timestamp: 1 }],
    });

  it.each(["a", "界", "🧪", "\\", "\n", "\u0000", "\ud800"])(
    "counts exact serialized UTF-8 boundaries for %j without truncation",
    (unit) => {
      const overhead = prepareGoogleAcpInput(context(""), []).bytes;
      const unitBytes = prepareGoogleAcpInput(context(unit), []).bytes - overhead;
      const repeats = Math.floor((limit - overhead) / unitBytes);
      const content = unit.repeat(repeats) + "x".repeat(limit - overhead - repeats * unitBytes);
      const prepared = prepareGoogleAcpInput(context(content), []);
      expect(prepared.bytes).toBe(limit);
      expect(prepared.text).toContain(JSON.stringify(content));
      expect(() => prepareGoogleAcpInput(context(`${content}x`), [])).toThrow(AcpProviderError);
      expect(() => prepareGoogleAcpInput(context(`${content}x`), [])).toThrow(
        expect.objectContaining({ kind: "context_limit" }),
      );
    },
  );

  it("preserves transcript roles and tool data while excluding private thinking", () => {
    const input = normalizeContext({
      systemPrompt: "separate instructions",
      messages: [
        { role: "user", content: "user data", timestamp: 1 },
        {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private".repeat(limit) },
            { type: "text", text: "answer" },
            { type: "toolCall", id: "call", name: "read", arguments: { path: "sample" } },
          ],
          api: "acp",
          provider: "google-antigravity",
          model: "fixture",
          stopReason: "toolUse",
          timestamp: 2,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
        {
          role: "toolResult",
          toolCallId: "call",
          toolName: "read",
          isError: true,
          content: [{ type: "text", text: "denied" }],
          timestamp: 3,
        },
      ],
    });
    const result = prepareGoogleAcpInput(input, []);
    expect(result.systemPrompt).toBe("separate instructions");
    expect(JSON.parse(result.text.slice(result.text.indexOf("\n") + 1))).toEqual([
      { role: "user", content: "user data" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "answer" },
          { type: "toolCall", id: "call", name: "read", arguments: { path: "sample" } },
        ],
      },
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "denied" }],
      },
    ]);
    input.messages.push({
      role: "user",
      content: [{ type: "image", data: "AA==", mimeType: "image/png" }],
      timestamp: 4,
    });
    const preparedWithImage = prepareGoogleAcpInput(input, []);
    expect(preparedWithImage.text).toContain("[provided as an ACP image block]");
  });

  it("converts GIF attachments to bounded PNG frame samples", async () => {
    const imageContext = context("");
    imageContext.messages.push({
      role: "user",
      content: [
        {
          type: "image",
          data: "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
          mimeType: "image/gif",
        },
      ],
      timestamp: 1,
    });
    await expect(googleAcpPromptImages(imageContext)).resolves.toEqual([
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    ]);
  });

  it("keeps separately transported MCP schemas out of the native text prompt budget", () => {
    const tools = [
      {
        name: "read",
        description: "説明",
        parameters: Type.Object({ value: Type.String({ description: "🧪" }) }),
      },
    ];
    const base = prepareGoogleAcpInput(context("tail", "instructions"), tools);
    const declarations = JSON.stringify(
      tools.map(({ name, description, parameters }) => ({
        name,
        description,
        inputSchema: parameters,
      })),
    );
    expect(base.bytes).toBe(Buffer.byteLength(base.text) + Buffer.byteLength(base.systemPrompt));
    expect(base.toolBytes).toBe(Buffer.byteLength(declarations));
    tools[0]!.description += "x".repeat(limit);
    expect(prepareGoogleAcpInput(context("tail", "instructions"), tools).bytes).toBe(base.bytes);
    tools[0]!.description = "Read";
    const padding = "x".repeat(limit - base.bytes);
    expect(prepareGoogleAcpInput(context("tail", `instructions${padding}`), tools).bytes).toBe(
      limit,
    );
    expect(() => prepareGoogleAcpInput(context("tail", `instructions${padding}x`), tools)).toThrow(
      expect.objectContaining({ kind: "context_limit" }),
    );
  });

  it.each(["history", "system"])(
    "rejects oversized %s before constructing a native host",
    async (source) => {
      const parent = await mkdtemp(path.join(os.tmpdir(), "google-acp-preflight-"));
      const host = vi.spyOn(acpProcess, "createAcpProcessHost");
      const callTool = vi.fn();
      const update = vi.fn();
      const signal = new AbortController().signal;
      const huge = "界".repeat(limit);
      try {
        const run = await createGoogleAcpRun(
          {
            provider: "google-antigravity",
            id: "fixture",
            nativeAuth: {
              provider: "google-antigravity",
              profile: profile(),
              persist: async () => true,
            },
          },
          { executable: process.execPath, workspace: parent, profileParent: parent },
          {
            tools:
              source === "tools"
                ? [
                    {
                      name: "read",
                      description: "Read",
                      parameters: Type.Object({ value: Type.String({ description: huge }) }),
                    },
                  ]
                : [],
            callTool,
            signal,
          },
        );
        try {
          await expect(
            run.prompt(
              context(
                source === "history" ? huge : "short",
                source === "system" ? huge : "instructions",
              ),
              update,
              signal,
            ),
          ).rejects.toMatchObject({ kind: "context_limit" });
          expect(host).not.toHaveBeenCalled();
          expect(callTool).not.toHaveBeenCalled();
          expect(update).not.toHaveBeenCalled();
        } finally {
          await run.close();
        }
        expect(await readdir(parent)).toEqual([]);
      } finally {
        host.mockRestore();
        await rm(parent, { recursive: true, force: true });
      }
    },
  );
});
