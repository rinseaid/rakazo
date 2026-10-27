import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGoogleAcpLogin,
  googleAcpCallback,
  parseGoogleAcpAuthorization,
} from "./google-acp-login.js";

function authorization(redirect = "http://127.0.0.1:12345/callback") {
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  for (const [name, value] of Object.entries({
    redirect_uri: redirect,
    state: "fixture-state",
    client_id: "fixture-client",
    code_challenge: "fixture-challenge",
    code_challenge_method: "S256",
    response_type: "code",
  }))
    url.searchParams.set(name, value);
  return url;
}
const fakeAgent = `
const fs=require('node:fs'),path=require('node:path'),http=require('node:http'),cp=require('node:child_process');
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
require('node:readline').createInterface({input:process.stdin}).on('line',async line=>{
 const request=JSON.parse(line);
 if(request.method==='initialize') reply(request.id,{protocolVersion:1,agentCapabilities:{},authMethods:[{id:'oauth-personal',name:'Google'}]});
 if(request.method==='authenticate') {
  const server=http.createServer((req,res)=>{
   const u=new URL(req.url,'http://127.0.0.1');
   if(u.searchParams.get('code')!=='fixture-code'||u.searchParams.get('state')!=='fixture-state'){res.writeHead(400);res.end();return;}
   fs.writeFileSync(path.join(process.env.GEMINI_HOME,'antigravity-acp','acp_token.json'),JSON.stringify({refresh_token:'fake-refresh-fixture',client_id:'fake-client',client_secret:'fake-client-secret',token_uri:'https://oauth2.googleapis.com/token'}),{mode:0o600});
   res.end('ok'); reply(request.id,{});server.close();
  });
  server.listen(0,'127.0.0.1',()=>{
   const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
   for(const [key,value] of Object.entries({redirect_uri:'http://127.0.0.1:'+server.address().port+'/callback',state:'fixture-state',client_id:'fixture-client',code_challenge:'fixture-challenge',code_challenge_method:'S256',response_type:'code'}))url.searchParams.set(key,value);
   cp.execFile(process.env.BROWSER,[url.toString()],()=>{});
  });
 }
});`;
const fakeAgentStderr = fakeAgent.replace(
  "cp.execFile(process.env.BROWSER,[url.toString()],()=>{});",
  "process.stderr.write('Open the following link to authenticate: '+url.toString()+'\\n');",
);

describe("Google native login relay", () => {
  it("forwards only the current login's code and state to its exact listener", () => {
    const auth = parseGoogleAcpAuthorization(authorization().toString());
    const callback = googleAcpCallback(
      "http://127.0.0.1:12345/callback?state=fixture-state&code=fixture-code&extra=ignored",
      auth,
    );
    expect([...callback.searchParams.keys()]).toEqual(["state", "code"]);
    expect(callback.origin).toBe("http://127.0.0.1:12345");
  });

  it("rejects malicious authorization and callback destinations without echoing input", () => {
    const auth = parseGoogleAcpAuthorization(authorization().toString());
    for (const redirect of [
      "https://example.test/cb",
      "http://localhost:12345/cb",
      "http://127.0.0.1.evil.test:1/cb",
      "file:///private",
      "http://user:password@127.0.0.1:12345/cb",
    ]) {
      expect(() => parseGoogleAcpAuthorization(authorization(redirect).toString())).toThrow(
        "unexpected authorization",
      );
    }
    for (const input of [
      "http://127.0.0.1:12346/callback?state=fixture-state&code=fake",
      "http://127.0.0.1:12345/other?state=fixture-state&code=fake",
      "http://127.0.0.1:12345/callback?state=wrong&code=fake",
      "http://127.0.0.1:12345/callback?state=fixture-state&state=fixture-state&code=fake",
      "http://127.0.0.1:12345/callback?state=fixture-state&code=a&code=b",
      "http://127.0.0.1:12345/callback?state=fixture-state&code=fake&error=denied",
      "not a callback",
    ]) {
      expect(() => googleAcpCallback(input, auth)).toThrow("does not match");
    }
  });

  it("reports only a fixed callback rejection category", () => {
    const failures: string[] = [];
    const auth = parseGoogleAcpAuthorization(authorization().toString());
    expect(() =>
      googleAcpCallback(
        "http://127.0.0.1:12345/callback?state=wrong&code=private-code",
        auth,
        (reason) => failures.push(reason),
      ),
    ).toThrow("does not match");
    expect(failures).toEqual(["state_mismatch"]);
    expect(JSON.stringify(failures)).not.toContain("private-code");
  });

  it.each([
    ["captured browser URL", fakeAgent],
    ["validated stderr URL", fakeAgentStderr],
  ])("completes the local relay using %s without any Google request", async (_name, executableSource) => {
    const parent = await mkdtemp(path.join(os.tmpdir(), "acp-login-fixture-"));
    let displayed = "";
    const diagnostics: Array<Record<string, unknown>> = [];
    try {
      const login = createGoogleAcpLogin({
        executable: process.execPath,
        args: ["-e", executableSource],
        profileParent: parent,
        onDiagnostic: (event) => diagnostics.push(event),
      });
      const secret = await login({
        provider: "google-antigravity",
        loginId: "test",
        actor: { userId: "test", spaceId: "test" },
        signal: new AbortController().signal,
        interaction: {
          notify(event) {
            if (event.type === "auth_url") displayed = event.url;
          },
          async prompt() {
            const url = new URL(displayed);
            const callback = new URL(url.searchParams.get("redirect_uri")!);
            callback.searchParams.set("state", url.searchParams.get("state")!);
            callback.searchParams.set("code", "fixture-code");
            return callback.toString();
          },
        },
      });
      expect(secret.kind).toBe("native");
      expect(secret.provider).toBe("google-antigravity");
      expect(secret.profile.files).toHaveLength(2);
      expect(secret).not.toHaveProperty("credential");
      expect(await readdir(parent)).toEqual([]);
      expect(diagnostics.map((event) => event.stage)).toEqual([
        "acp_process_ready",
        "acp_initialize_complete",
        "auth_dispatched",
        "oauth_url_capture_checked",
        "callback_requested",
        "acp_child_exit",
        "account_state_validated",
      ]);
      expect(diagnostics.every((event) => Number.isSafeInteger(event.durationMs))).toBe(true);
      const serialized = JSON.stringify(diagnostics);
      for (const sensitive of [
        displayed,
        "fixture-state",
        "fixture-code",
        "fake-refresh-fixture",
        "fake-client-secret",
        "accounts.google.com",
      ])
        expect(serialized).not.toContain(sensitive);
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
