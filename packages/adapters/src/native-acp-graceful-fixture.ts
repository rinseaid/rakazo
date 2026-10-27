/** TEST ONLY: observe orderly EOF after end_turn separately from forced cleanup. */
import { spawn } from "node:child_process";
import { once } from "node:events";
import type { AcpSessionHost } from "./acp-session.js";
import { AcpStreamTransport } from "./acp-transport.js";

export function createGracefulFixtureHost(options: {
  executable: string;
  args?: readonly string[];
  cwd: string;
  home: string;
  env?: Readonly<Record<string, string>>;
  requestTimeoutMs?: number;
  eofGraceMs?: number;
}) {
  const grace = options.eofGraceMs ?? 10_000;
  if (!Number.isSafeInteger(grace) || grace <= 0 || grace > 10_000)
    throw new Error("Invalid EOF fixture bound");
  const evidence = {
    normalFinishes: 0,
    eofExits: 0,
    termSignals: 0,
    killSignals: 0,
    groupsGone: 0,
    exitCode: null as number | null,
  };
  let finish: (() => Promise<void>) | undefined;
  const host: AcpSessionHost = {
    async connect(handlers, signal) {
      signal?.throwIfAborted();
      const child = spawn(options.executable, [...(options.args ?? [])], {
        cwd: options.cwd,
        env: {
          PATH: "/usr/bin:/bin",
          LANG: "C.UTF-8",
          ...options.env,
          HOME: options.home,
          USERPROFILE: options.home,
        },
        detached: true,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
      });
      child.stderr.resume();
      child.stdin.on("error", () => {});
      let closed = false;
      const closedPromise = new Promise<void>((resolve) =>
        child.once("close", (code) => {
          closed = true;
          evidence.exitCode = code;
          resolve();
        }),
      );
      const groupExists = () => {
        if (!child.pid) return false;
        try {
          process.kill(-child.pid, 0);
          return true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
          throw new Error("Fixture process-group check failed");
        }
      };
      const send = (kind: "SIGTERM" | "SIGKILL") => {
        if (!groupExists()) return;
        process.kill(-child.pid!, kind);
        if (kind === "SIGTERM") evidence.termSignals++;
        else evidence.killSignals++;
      };
      async function boundedWait(ms: number) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closedPromise,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, ms);
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      }
      async function requireGroupGone() {
        const until = Date.now() + 2000;
        while (groupExists() && Date.now() < until)
          await new Promise((resolve) => setTimeout(resolve, 20));
        if (groupExists()) throw new Error("Fixture process group survived cleanup");
        evidence.groupsGone = 1;
      }
      let forced: Promise<void> | undefined;
      const forceStop = () => {
        forced ??= (async () => {
          send("SIGTERM");
          await boundedWait(2000);
          if (groupExists()) send("SIGKILL");
          await boundedWait(2000);
          if (!closed) throw new Error("Fixture process failed to exit");
          await requireGroupGone();
        })();
        return forced;
      };
      let normal: Promise<void> | undefined;
      const abort = () => {
        void forceStop().catch(() => {});
      };
      signal?.addEventListener("abort", abort, { once: true });
      finish = () => {
        normal ??= (async () => {
          evidence.normalFinishes++;
          if (signal?.aborted || forced) throw new Error("Aborted turns cannot finish normally");
          child.stdin.end();
          await boundedWait(grace);
          if (!closed || evidence.exitCode !== 0 || groupExists() || forced) {
            await forceStop();
            throw new Error("Orderly EOF close was not confirmed");
          }
          evidence.eofExits++;
          await requireGroupGone();
          signal?.removeEventListener("abort", abort);
        })();
        return normal;
      };
      try {
        await once(child, "spawn");
        signal?.throwIfAborted();
        // During intentional EOF, SDK's connection.closed callback must not race
        // graceful shutdown with SIGTERM. Abort still uses forceStop directly.
        return new AcpStreamTransport(
          child.stdout,
          child.stdin,
          handlers,
          () => normal ?? forceStop(),
          options.requestTimeoutMs,
        );
      } catch {
        await forceStop();
        throw new Error("Fixture process did not start");
      }
    },
  };
  return {
    host,
    evidence,
    async finishNormally() {
      if (!finish) throw new Error("Fixture process not started");
      await finish();
    },
  };
}
