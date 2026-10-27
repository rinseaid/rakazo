import { spawn } from "node:child_process";
import { once } from "node:events";
import path from "node:path";
import type { AcpSessionHost } from "./acp-session.js";
import { AcpStreamTransport } from "./acp-transport.js";

type AcpProcessLifecycleEvent =
  | { type: "stdin-finish" | "stdin-close" | "stdout-close" | "stderr-close" }
  | { type: "child-exit" | "child-close"; code: number | null; signal: NodeJS.Signals | null }
  | { type: "forced-signal"; signal: NodeJS.Signals };

/**
 * Local process driver for code executing INSIDE an already-isolated computer.
 * This is not a sandbox. API composition must not use it as a fallback for a
 * remote computer which cannot supply an authorized process transport.
 */
export function createAcpProcessHost(options: {
  executable: string;
  args?: readonly string[];
  cwd: string;
  home: string;
  /** Explicit environment only: no inherited account keys, proxy auth or HOME. */
  env?: Readonly<Record<string, string>>;
  approve?: AcpSessionHost["approve"];
  requestTimeoutMs?: number;
  terminateGraceMs?: number;
  /** EOF grace before forced process-group cleanup after a completed end_turn. */
  gracefulFinishMs?: number;
  /** Local lifecycle diagnostics for qualification fixtures; never receives process output. */
  onLifecycleEvent?: (event: AcpProcessLifecycleEvent) => void;
  /** Bounded consumers may inspect stderr without persisting or logging it. */
  onStderrData?: (chunk: Buffer) => void;
}): AcpSessionHost {
  if (process.platform === "win32")
    throw new Error("ACP process-tree cleanup requires a platform driver");
  for (const value of [options.executable, options.cwd, options.home]) {
    if (!path.isAbsolute(value) || value.includes("\0"))
      throw new Error("ACP paths must be absolute");
  }
  const grace = options.terminateGraceMs ?? 1000;
  if (!Number.isSafeInteger(grace) || grace <= 0 || grace > 10000)
    throw new Error("Invalid ACP shutdown grace");
  const finishGrace = options.gracefulFinishMs ?? 10_000;
  if (!Number.isSafeInteger(finishGrace) || finishGrace <= 0 || finishGrace > 10_000)
    throw new Error("Invalid ACP graceful finish grace");
  return {
    approve: options.approve,
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
        shell: false,
        detached: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Drain stderr so the child cannot deadlock. Never log raw agent output.
      if (options.onStderrData) {
        child.stderr.on("data", (chunk: Buffer) => {
          try {
            options.onStderrData?.(chunk);
          } catch {
            // A bounded stderr observer cannot change process behavior.
          }
        });
      }
      child.stderr.resume();
      const observe = (event: AcpProcessLifecycleEvent) => {
        try {
          options.onLifecycleEvent?.(event);
        } catch {
          // Qualification diagnostics must not alter process cleanup.
        }
      };
      child.stdin.once("finish", () => observe({ type: "stdin-finish" }));
      child.stdin.once("close", () => observe({ type: "stdin-close" }));
      child.stdout.once("close", () => observe({ type: "stdout-close" }));
      child.stderr.once("close", () => observe({ type: "stderr-close" }));
      let exited = false;
      let exitCode: number | null | undefined;
      let closePromise: Promise<void> | undefined;
      child.once("exit", (code, signal) => observe({ type: "child-exit", code, signal }));
      const exit = new Promise<void>((resolve) =>
        child.once("close", (code, signal) => {
          exited = true;
          exitCode = code;
          observe({ type: "child-close", code, signal });
          resolve();
        }),
      );
      const signalGroup = (kind: NodeJS.Signals) => {
        if (!child.pid) return;
        observe({ type: "forced-signal", signal: kind });
        try {
          process.kill(-child.pid, kind);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            throw new Error("ACP process cleanup failed");
        }
      };
      const processGroupGone = () => {
        if (!child.pid) return true;
        try {
          process.kill(-child.pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
          if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
          throw new Error("ACP process group status is unavailable");
        }
      };
      const waitForGroupGone = async (timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (!processGroupGone()) {
          if (Date.now() >= deadline) return false;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return true;
      };
      const waitForCleanExit = async (timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs;
        while (true) {
          if (signal?.aborted || Date.now() >= deadline) return false;
          if (exited && exitCode === 0 && processGroupGone()) return true;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      };
      const stop = (): Promise<void> => {
        if (closePromise) return closePromise;
        closePromise = (async () => {
          signal?.removeEventListener("abort", abort);
          if (processGroupGone()) {
            if (!exited) await exit;
            return;
          }
          signalGroup("SIGTERM");
          if (!(await waitForGroupGone(grace))) {
            signalGroup("SIGKILL");
            if (!(await waitForGroupGone(grace))) throw new Error("ACP process group did not stop");
          }
          if (!exited) await exit;
        })();
        return closePromise;
      };
      let gracefulPromise: Promise<{ clean: boolean; stopped: boolean }> | undefined;
      const finishGracefully = (): Promise<{ clean: boolean; stopped: boolean }> => {
        if (gracefulPromise) return gracefulPromise;
        gracefulPromise = (async () => {
          if (!signal?.aborted) child.stdin.end();
          const clean = !signal?.aborted && (await waitForCleanExit(finishGrace));
          if (clean) {
            signal?.removeEventListener("abort", abort);
            return { clean: true, stopped: true };
          }
          await stop();
          return { clean: false, stopped: true };
        })();
        return gracefulPromise;
      };
      const abort = () => {
        void stop().catch(() => undefined);
      };
      signal?.addEventListener("abort", abort, { once: true });
      try {
        await once(child, "spawn");
        if (signal?.aborted) {
          await stop();
          signal.throwIfAborted();
        }
        return new AcpStreamTransport(
          child.stdout,
          child.stdin,
          handlers,
          stop,
          options.requestTimeoutMs,
          finishGracefully,
        );
      } catch {
        await stop().catch(() => undefined);
        throw new Error("ACP process could not start");
      }
    },
  };
}
