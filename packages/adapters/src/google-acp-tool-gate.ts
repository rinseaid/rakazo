/**
 * Optional Antigravity pre-tool gate. This module never grants ACP permission.
 * A caller must separately retain native policy denials and Pi's effect approval.
 * Trust model: pinned runtime, private host, no shared workspace/binds or other
 * untrusted processes. Native tools cannot write here; Pi effects run elsewhere.
 * Not containment against arbitrary same-UID code or a malicious runtime.
 */
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";

const CUSTOMIZATION_DIRS = [".agents", ".agent", "_agents", "_agent"] as const;
const digest = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`;
const identifier = (value: string) => /^[A-Za-z0-9_.-]{1,128}$/.test(value);

export interface GoogleAcpToolGate {
  readonly serverName: string;
  readonly projectedNames: readonly string[];
  readonly originalNames: readonly string[];
  project(originalName: string): string;
  restore(projectedName: string): string;
}

/** Build a closed bijection. No wildcard/prefix-based authorization is used. */
export function createGoogleAcpToolGate(
  serverName: string,
  originalNames: readonly string[],
  otherCanonicalNames: readonly string[],
): GoogleAcpToolGate {
  if (!identifier(serverName) || originalNames.length > 256)
    throw new Error("Invalid gate registry");
  const originals = [...originalNames];
  if (originals.some((name) => !identifier(name)) || new Set(originals).size !== originals.length)
    throw new Error("Invalid gate tool names");
  const names = originals.map(
    (name) => `rkz_pi_${digest(JSON.stringify([serverName, name])).slice(0, 40)}`,
  );
  if (
    new Set(names).size !== names.length ||
    names.some((name) => otherCanonicalNames.includes(name))
  )
    throw new Error("Gate namespace collision");
  const forward = new Map(originals.map((name, i) => [name, names[i]!]));
  const reverse = new Map(names.map((name, i) => [name, originals[i]!]));
  return Object.freeze({
    serverName,
    projectedNames: Object.freeze(names),
    originalNames: Object.freeze(originals),
    project(name: string) {
      const found = forward.get(name);
      if (!found) throw new Error("Tool absent from gate registry");
      return found;
    },
    restore(name: string) {
      const found = reverse.get(name);
      if (!found) throw new Error("Tool absent from gate registry");
      return found;
    },
  });
}

export const GATE_INTERPRETER = "/usr/local/bin/node";
export const GATE_SCRIPT_PATH = "/usr/local/lib/rakazo-acp-tool-gate.mjs";
/**
 * Fixed image artifact. argv[2] is authored in verified provider config.
 * Inputs over 1 MiB are denied, including otherwise valid oversized tool args.
 */
export const GOOGLE_ACP_GATE_SCRIPT = `let input='';
let allowTool=false;
try {
 const names=JSON.parse(process.argv[2]);
 if(!Array.isArray(names)||names.length>256||
  names.some(name=>typeof name!=='string'||!/^rkz_pi_[a-f0-9]{40}$/.test(name))||
  new Set(names).size!==names.length) throw Error('registry');
 for await (const chunk of process.stdin) {
  input+=chunk;
  if(input.length>1048576) throw Error('input bound');
 }
 const data=JSON.parse(input);
 allowTool=Boolean(data && typeof data==='object' && !Array.isArray(data) &&
  data.toolCall && typeof data.toolCall==='object' && !Array.isArray(data.toolCall) &&
  names.includes(data.toolCall.name));
} catch { allowTool=false; }
process.stdout.write(JSON.stringify({allowTool,denyReason:'Tool not available through the owned bridge'}), error=>{if(error) process.exitCode=1;});
`;

export const GATE_MANIFEST_PATH = "/usr/local/lib/rakazo-acp-gate-manifest.json";
export const GATE_NATIVE_RUNTIME = "/opt/rakazo/antigravity-acp/agy_acp_server.par";
/** Read build-authored provenance from the optional pinned image, never user settings. */
export async function loadGoogleAcpGateImage(): Promise<{ interpreterSha256: string }> {
  const stat = await lstat(GATE_MANIFEST_PATH);
  if (
    !stat.isFile() ||
    stat.isSymbolicLink() ||
    stat.uid !== 0 ||
    (stat.mode & 0o022) !== 0 ||
    stat.size > 4096
  )
    throw new Error("Untrusted gate image manifest");
  const manifest = JSON.parse(await readFile(GATE_MANIFEST_PATH, "utf8"));
  if (
    manifest.version !== 1 ||
    manifest.runtimeVersion !== "1.4.3" ||
    !/^[a-f0-9]{64}$/.test(manifest.interpreterSha256) ||
    manifest.scriptSha256 !== digest(GOOGLE_ACP_GATE_SCRIPT)
  )
    throw new Error("Gate image manifest mismatch");
  return Object.freeze({ interpreterSha256: manifest.interpreterSha256 });
}

export interface GoogleAcpGateDeployment {
  /** Expected digest from the pinned image build, not the running file itself. */
  readonly interpreterSha256: string;
  readonly geminiHome: string;
  readonly cwd: string;
}

function validatePaths(deployment: GoogleAcpGateDeployment) {
  for (const value of [GATE_INTERPRETER, GATE_SCRIPT_PATH, deployment.geminiHome, deployment.cwd]) {
    if (!path.isAbsolute(value) || path.normalize(value) !== value || /[\0\r\n]/.test(value))
      throw new Error("Noncanonical gate path");
  }
  if (!/^[a-f0-9]{64}$/.test(deployment.interpreterSha256))
    throw new Error("Interpreter digest required");
}

/** Exact supported global hooks.json bytes, to provision in the private host. */
export function googleAcpGateFiles(gate: GoogleAcpToolGate, deployment: GoogleAcpGateDeployment) {
  validatePaths(deployment);
  const configPath = path.join(deployment.geminiHome, "config", "hooks.json");
  if (GATE_SCRIPT_PATH === configPath) throw new Error("Gate paths overlap");
  const config = JSON.stringify({
    "owned-tool-gate": {
      enabled: true,
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command: `${quote(GATE_INTERPRETER)} ${quote(GATE_SCRIPT_PATH)} ${quote(JSON.stringify(gate.projectedNames))}`,
              timeout: 5,
            },
          ],
        },
      ],
    },
  });
  return Object.freeze({
    configPath,
    config,
    scriptPath: GATE_SCRIPT_PATH,
    script: GOOGLE_ACP_GATE_SCRIPT,
  });
}

export interface GoogleAcpGateSessionSettings {
  readonly enabledTools: readonly string[];
  readonly fsCapabilities: Readonly<Record<string, unknown>>;
  readonly registeredServers: readonly { name: string; toolNames: readonly string[] }[];
}

export function validateGoogleAcpGateSession(
  gate: GoogleAcpToolGate,
  settings: GoogleAcpGateSessionSettings,
): void {
  const { registeredServers } = settings;
  if (settings.enabledTools.length !== 0 || Object.keys(settings.fsCapabilities).length !== 0)
    throw new Error("Native tools and client filesystem capabilities must be disabled");
  if (
    registeredServers.length !== 1 ||
    registeredServers[0]!.name !== gate.serverName ||
    JSON.stringify([...registeredServers[0]!.toolNames].sort()) !==
      JSON.stringify([...gate.projectedNames].sort())
  )
    throw new Error("Gate requires exactly the owned closed MCP registry");
}

/**
 * Mandatory pre-launch check, not an approval credential. Run again on every
 * launch/rebuild. This function does NOT create files or change host security.
 * The private host must have no untrusted programs, shared binds, or Pi effects
 * executing on its own filesystem. Modes alone do not protect against same-UID
 * modification. Caller must launch only the single MCP registration checked here, with
 * GEMINI_HOME/cwd fixed to deployment, and prohibit dynamic registry additions.
 */
export async function prepareGoogleAcpToolGate(
  gate: GoogleAcpToolGate,
  deployment: GoogleAcpGateDeployment,
  settings: GoogleAcpGateSessionSettings,
): Promise<void> {
  const files = googleAcpGateFiles(gate, deployment);
  validateGoogleAcpGateSession(gate, settings);
  const absent = [
    path.join(deployment.geminiHome, "config", "mcp_config.json"),
    ...CUSTOMIZATION_DIRS.flatMap((dir) =>
      ["hooks.json", "mcp_config.json"].map((file) => path.join(deployment.cwd, dir, file)),
    ),
  ];
  for (const dir of [deployment.geminiHome, deployment.cwd])
    if ((await realpath(dir)) !== dir) throw new Error("Gate directory resolves elsewhere");
  for (const [file, expected] of [
    [GATE_INTERPRETER, deployment.interpreterSha256],
    [files.scriptPath, digest(files.script)],
    [files.configPath, digest(files.config)],
  ] as const) {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (await realpath(file)) !== file)
      throw new Error("Gate artifact must be a canonical regular file");
    if (digest(await readFile(file)) !== expected)
      throw new Error("Gate artifact integrity mismatch");
  }
  for (const file of absent) {
    try {
      await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    throw new Error("Ambient MCP or workspace hooks are not permitted");
  }
}
