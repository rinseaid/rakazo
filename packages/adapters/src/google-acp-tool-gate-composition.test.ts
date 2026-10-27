import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeContext, Type } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as processModule from "./acp-process.js";
import { createGoogleAcpRun } from "./google-acp-provider.js";
import * as gateModule from "./google-acp-tool-gate.js";

const agent = `
let endpoint, mcpSession, promptId, toolName;
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
async function mcp(method,params,notify=false){
 const headers=Object.fromEntries(endpoint.headers.map(h=>[h.name,h.value]));
 Object.assign(headers,{'Content-Type':'application/json','Accept':'application/json, text/event-stream'});
 if(mcpSession)headers['Mcp-Session-Id']=mcpSession;
 const response=await fetch(endpoint.url,{method:'POST',headers,body:JSON.stringify({jsonrpc:'2.0',...(notify?{}:{id:method}),method,params})});
 mcpSession=response.headers.get('mcp-session-id')||mcpSession;
 if(notify)return;
 return (await response.json()).result;
}
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 const req=JSON.parse(line);
 try {
  if(req.method==='initialize')send(req.id,{protocolVersion:1,agentCapabilities:{mcpCapabilities:{http:true},loadSession:true},authMethods:[]});
  else if(req.method==='session/new'||req.method==='session/load'){
   if(req.params._meta.antigravity.enabledTools.length)throw Error();
   endpoint=req.params.mcpServers[0];
   send(req.id,{sessionId:'fixture-session',modes:{currentModeId:'default',availableModes:[{id:'default',name:'Default'}]},models:{currentModelId:'fixture',availableModels:[{modelId:'fixture',name:'Fixture'}]}});
  }else if(req.method==='session/set_mode'||req.method==='session/set_model')send(req.id,{});
  else if(req.method==='session/prompt'){
   promptId=req.id;
   await mcp('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture',version:'1'}});
   await mcp('notifications/initialized',{},true);
   const tools=(await mcp('tools/list',{})).tools;
   if(tools.length===0){send(promptId,{stopReason:'end_turn'});return;}
   toolName=tools[0].name;
   if(!/^rkz_pi_[a-f0-9]{40}$/.test(toolName))throw Error();
   process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:'fixture-permission',method:'session/request_permission',params:{sessionId:'fixture-session',toolCall:{toolCallId:'fixture-call',title:'Fixture bridge',kind:'other'},options:[{optionId:'once',kind:'allow_once',name:'Once'},{optionId:'reject',kind:'reject_once',name:'Reject'}]}})+'\\n');
  }else if(req.id==='fixture-permission'){
   if(req.result?.outcome?.optionId==='once')await mcp('tools/call',{name:toolName,arguments:{value:'fixture'}});
   send(promptId,{stopReason:'end_turn'});
  }
 }catch {send(promptId??req.id,{stopReason:'cancelled'});}
});`;

afterEach(() => vi.restoreAllMocks());

describe("optional image gate provider composition", () => {
  it.each([
    "allow",
    "restore",
    "pi-deny",
    "preflight-fails",
    "permission-recheck-fails",
    "no-tools",
  ])("keeps the effect boundary: %s", async (mode) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "gate-composition-"));
    const persist = vi.fn(async () => true);
    let effects = 0;
    const callTool = vi.fn(async (name: string) => {
      expect(name).toBe("fixture_original");
      if (mode !== "pi-deny") effects++;
      return {
        role: "toolResult" as const,
        toolName: name,
        toolCallId: "fixture",
        content: [{ type: "text" as const, text: "fixture-result" }],
        isError: mode === "pi-deny",
        timestamp: 0,
      };
    });
    const originalHost = processModule.createAcpProcessHost;
    const spawn = vi.spyOn(processModule, "createAcpProcessHost").mockImplementation((options) => {
      expect(options.executable).toBe(gateModule.GATE_NATIVE_RUNTIME);
      return originalHost({ ...options, executable: process.execPath, args: ["-e", agent] });
    });
    // Mock only fixed image filesystem verification. Exact closed config creation,
    // scoped profile, process protocol, permission selection and MCP are real.
    const prepare = vi
      .spyOn(gateModule, "prepareGoogleAcpToolGate")
      .mockImplementation(async (gate, deployment, settings) => {
        gateModule.validateGoogleAcpGateSession(gate, settings);
        const expected = gateModule.googleAcpGateFiles(gate, deployment);
        expect(await readFile(expected.configPath, "utf8")).toBe(expected.config);
        if (
          mode === "preflight-fails" ||
          (mode === "permission-recheck-fails" && prepare.mock.calls.length > 1)
        )
          throw new Error("image unavailable");
      });
    let run: Awaited<ReturnType<typeof createGoogleAcpRun>> | undefined;
    try {
      run = await createGoogleAcpRun(
        {
          provider: "google-antigravity",
          id: "fixture",
          nativeAuth: {
            provider: "google-antigravity",
            persist,
            profile: {
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
                    client_secret: "fake-secret",
                    token_uri: "https://oauth2.googleapis.com/token",
                  }),
                },
              ],
            },
          },
        },
        {
          executable: gateModule.GATE_NATIVE_RUNTIME,
          workspace: parent,
          profileParent: parent,
          toolGateImage: { interpreterSha256: "a".repeat(64) },
        },
        {
          tools:
            mode === "no-tools"
              ? []
              : [
                  {
                    name: "fixture_original",
                    description: "Fixture",
                    parameters: Type.Object({ value: Type.String() }),
                  },
                ],
          conversation:
            mode === "restore"
              ? {
                  restore: {
                    version: 1,
                    sessionId: "fixture-session",
                    data: Buffer.from("synthetic native state").toString("base64"),
                  },
                  offerCandidate: vi.fn(),
                }
              : undefined,
          callTool,
          signal: new AbortController().signal,
        },
      );
      const prompt = run.prompt(
        normalizeContext({
          systemPrompt: "fixture instructions",
          messages: [{ role: "user", content: "fixture", timestamp: 0 }],
        }),
        () => {},
        new AbortController().signal,
      );
      if (mode === "preflight-fails") {
        await expect(prompt).rejects.toThrow();
        expect(spawn).not.toHaveBeenCalled();
      } else await prompt;
      expect(callTool).toHaveBeenCalledTimes(
        mode === "allow" || mode === "restore" || mode === "pi-deny" ? 1 : 0,
      );
      expect(effects).toBe(mode === "allow" || mode === "restore" ? 1 : 0);
      expect(prepare).toHaveBeenCalledTimes(
        mode === "preflight-fails" || mode === "no-tools" ? 1 : 2,
      );
    } finally {
      await run?.close();
      expect(await readdir(parent)).toEqual([]);
      await rm(parent, { recursive: true, force: true });
    }
  });
});
