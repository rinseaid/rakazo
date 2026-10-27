import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  browserProfilePathForScreen,
  prepareBrowserProfileCommand,
  stopScreensCommand,
} from "./supervisor-logic.js";

const fixtures: string[] = [];
afterEach(() => {
  for (const directory of fixtures.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-profile-test-"));
  fixtures.push(root);
  const home = path.join(root, "home");
  const runtime = path.join(root, "runtime");
  const bin = path.join(root, "bin");
  const shared = path.join(home, ".browser-profiles/chromium");
  mkdirSync(shared, { recursive: true });
  mkdirSync(runtime);
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, "python3"),
    [
      "#!/bin/sh",
      'pid=""',
      'for arg in "$@"; do case "$arg" in \'\'|*[!0-9]*) ;; *) pid=$arg ;; esac; done',
      '[ -z "$pid" ] || kill "$pid" 2>/dev/null || true',
      "",
    ].join("\n"),
  );
  chmodSync(path.join(bin, "python3"), 0o755);
  const profile = (bot: string) => browserProfilePathForScreen(bot).replace("/home/rakazo", home);
  const run = (script: string) => {
    // GNU cp's reflink optimization has no macOS equivalent; all copy semantics remain intact.
    const portable =
      process.platform === "darwin" ? script.replaceAll(" --reflink=auto", "") : script;
    return spawnSync(
      "bash",
      ["-eu", "-c", portable.replaceAll("/tmp/rakazo", runtime).replaceAll("/home/rakazo", home)],
      {
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}` },
      },
    );
  };
  const startBrowser = async (bot: string, port: number) => {
    const directory = profile(bot);
    mkdirSync(directory, { recursive: true });
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120_000)"], {
      argv0: `chromium --user-data-dir=${directory} --remote-debugging-port=${port}`,
      detached: true,
      stdio: "ignore",
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    if (!child.pid) throw new Error("browser fixture did not start");
    const key = createHash("sha256").update(bot).digest("hex").slice(0, 32);
    writeFileSync(path.join(runtime, `browser-pid-${key}`), String(child.pid));
    return child;
  };
  return { shared, profile, run, runtime, startBrowser };
}

describe("durable independent browser profiles", () => {
  it("keeps both bots' data through stop and restart without copying the default profile", async () => {
    const { shared, profile, run, startBrowser } = fixture();
    const children: ChildProcess[] = [];
    writeFileSync(path.join(shared, "login"), "legacy-session");
    try {
      for (const bot of ["writer", "reader"]) {
        expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
        expect(existsSync(path.join(profile(bot), "login"))).toBe(false);
        writeFileSync(path.join(profile(bot), "login"), `${bot}-session`);
      }
      children.push(await startBrowser("writer", 9333), await startBrowser("reader", 9334));
      expect(
        run(
          stopScreensCommand([
            { screenId: "writer", index: 0 },
            { screenId: "reader", index: 1 },
          ]),
        ).status,
      ).toBe(0);
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          await new Promise<void>((resolve) => child.once("close", () => resolve()));
        }
        expect(child.signalCode).toBe("SIGTERM");
      }
      for (const bot of ["writer", "reader"]) {
        expect(run(prepareBrowserProfileCommand(bot)).status).toBe(0);
        expect(readFileSync(path.join(profile(bot), "login"), "utf8")).toBe(`${bot}-session`);
      }
      expect(run(prepareBrowserProfileCommand("new-bot")).status).toBe(0);
      expect(existsSync(path.join(profile("new-bot"), "login"))).toBe(false);
      expect(readFileSync(path.join(shared, "login"), "utf8")).toBe("legacy-session");
    } finally {
      for (const child of children) {
        if (!child.pid || child.exitCode !== null || child.signalCode !== null) continue;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
    }
  });
});
