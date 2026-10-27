import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { DuplexProcess } from "@rakazo/adapter-kit";
import { expect, it } from "vitest";
import type { NativeAccountDiagnostic } from "./native-account-diagnostics.js";
import { runNativeAccountOperation, serveNativeAccountOperation } from "./native-account-relay.js";

// Synthetic process speaks real ACP and a loopback callback. It never contacts Google.
const fakeAgent = `
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize') reply(request.id,{protocolVersion:1,agentCapabilities:{},authMethods:[{id:'oauth-personal',name:'Google'}]});
 if(request.method==='session/new') reply(request.id,{sessionId:'fixture-session',models:{currentModelId:'fixture-model',availableModels:[{modelId:'fixture-model',name:'Fixture model'}]}});
 if(request.method==='authenticate') {
  const server=http.createServer((req,res)=>{
   const u=new URL(req.url,'http://127.0.0.1');
   if(u.searchParams.get('code')!=='fixture-code'||u.searchParams.get('state')!=='fixture-state'){res.writeHead(400);res.end();return;}
   fs.writeFileSync(path.join(process.env.GEMINI_HOME,'antigravity-acp','acp_token.json'),JSON.stringify({refresh_token:'fixture-refresh',client_id:'fixture-client',client_secret:'fixture-secret',token_uri:'https://oauth2.googleapis.com/token'}),{mode:0o600});
   res.end('ok'); reply(request.id,{});server.close();
  });
  server.listen(0,'127.0.0.1',()=>{
   const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
   for(const [key,value] of Object.entries({redirect_uri:'http://127.0.0.1:'+server.address().port+'/callback',state:'fixture-state',client_id:'fixture-client',code_challenge:'fixture-challenge',code_challenge_method:'S256',response_type:'code'}))url.searchParams.set(key,value);
   cp.execFile(process.env.BROWSER,[url.toString()],()=>{});
  });
 }
});`;

it("carries a real fake-agent login through the private protocol then discovers its account catalog", async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "native-account-relay-fixture-"));
  const computer = {
    executable: process.execPath,
    args: ["-e", fakeAgent],
    profileParent: parent,
    workspace: parent,
  };
  function host(operation: "model-login" | "model-catalog"): DuplexProcess {
    const input = new PassThrough();
    const output = new PassThrough();
    const exited = serveNativeAccountOperation(input, output, operation, computer)
      .then(
        () => ({ code: 0 }),
        () => ({ code: 125 }),
      )
      .finally(() => output.end());
    return {
      events: (async function* () {
        for await (const chunk of output) yield { type: "stdout" as const, data: chunk.toString() };
      })(),
      async write(data) {
        input.write(data);
      },
      async end() {
        input.end();
      },
      async close() {
        input.destroy();
        await exited;
      },
      exited,
    };
  }
  let url = "";
  const diagnostics: NativeAccountDiagnostic[] = [];
  try {
    const login = await runNativeAccountOperation(
      host("model-login"),
      {
        kind: "login",
        provider: "google-antigravity",
        loginId: "fixture-login",
        actor: { userId: "fixture-user", spaceId: "fixture-space" },
      },
      {
        notify(event) {
          if (event.type === "auth_url") url = event.url;
        },
        async prompt() {
          const authorization = new URL(url);
          const callback = new URL(authorization.searchParams.get("redirect_uri")!);
          callback.searchParams.set("state", authorization.searchParams.get("state")!);
          callback.searchParams.set("code", "fixture-code");
          return callback.toString();
        },
      },
      new AbortController().signal,
      (event) => diagnostics.push(event),
    );
    expect(login.kind).toBe("login");
    if (login.kind !== "login") throw new Error("Unexpected result");
    expect(await readdir(parent)).toEqual([]);
    expect(diagnostics.map((event) => event.stage)).toEqual([
      "acp_process_ready",
      "acp_initialize_complete",
      "auth_dispatched",
      "oauth_url_capture_checked",
      "oauth_url_relayed",
      "callback_requested",
      "acp_child_exit",
      "account_state_validated",
    ]);
    expect(diagnostics.find((event) => event.stage === "acp_initialize_complete")).toMatchObject({
      protocolVersion: 1,
      authMethodAvailable: true,
    });
    expect(JSON.stringify(diagnostics)).not.toContain("fixture-state");
    const catalog = await runNativeAccountOperation(
      host("model-catalog"),
      {
        kind: "catalog",
        provider: "google-antigravity",
        profile: login.secret.profile,
      },
      undefined,
      new AbortController().signal,
    );
    expect(catalog.kind).toBe("catalog");
    if (catalog.kind !== "catalog") throw new Error("Unexpected result");
    expect(catalog.discovery.models).toEqual([{ id: "fixture-model", name: "Fixture model" }]);
    expect(catalog.profile).toEqual(login.secret.profile);
    expect(await readdir(parent)).toEqual([]);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});
