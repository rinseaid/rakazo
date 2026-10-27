import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import path from "node:path";
import type { AcpProfileFiles } from "./acp-profile.js";

/** Private staging directory for a process already inside its assigned computer. */
export async function createAcpLocalProfile(
  parent: string,
): Promise<AcpProfileFiles & { root: string }> {
  if (!path.isAbsolute(parent)) throw new Error("Account profile parent must be absolute");
  const root = await realpath(await mkdtemp(path.join(parent, "rakazo-acp-")));
  let disposed = false;
  let cleanup: Promise<void> | undefined;
  async function target(relative: string, create: boolean): Promise<string> {
    if (disposed) throw new Error("Account profile is closed");
    const parts = relative.split("/");
    if (
      !relative ||
      relative.includes("\\") ||
      relative.includes("\0") ||
      parts.some((part) => !part || part === "." || part === ".." || part.includes(":"))
    )
      throw new Error("Invalid profile path");
    let directory = root;
    for (const component of ["", ...parts.slice(0, -1)]) {
      if (component) directory = path.join(directory, component);
      if (create && component)
        await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        });
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
        throw new Error("Unsafe profile directory");
      const resolved = await realpath(directory);
      if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`))
        throw new Error("Profile escaped its lease");
    }
    return path.join(directory, parts.at(-1)!);
  }
  return {
    root,
    async writePrivate(relative, bytes) {
      let file: FileHandle | undefined;
      try {
        file = await open(
          await target(relative, true),
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await file.writeFile(bytes);
        await file.sync();
      } catch {
        throw new Error("Private account profile write failed");
      } finally {
        await file?.close();
      }
    },
    async readPrivate(relative, maxBytes) {
      if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > 4 * 1024 * 1024)
        throw new Error("Invalid profile read limit");
      let file: FileHandle | undefined;
      try {
        const filename = await target(relative, false);
        file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await file.stat();
        if (!stat.isFile() || stat.size > maxBytes || (stat.mode & 0o077) !== 0)
          throw new Error("Unsafe profile file");
        const bytes = Buffer.alloc(maxBytes + 1);
        let read = 0;
        while (read <= maxBytes) {
          const result = await file.read(bytes, read, bytes.length - read, read);
          if (!result.bytesRead) break;
          read += result.bytesRead;
        }
        if (read > maxBytes) throw new Error("Profile is too large");
        return bytes.subarray(0, read);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw new Error("Private account profile read failed");
      } finally {
        await file?.close();
      }
    },
    dispose() {
      disposed = true;
      cleanup ??= rm(root, { recursive: true, force: true });
      return cleanup;
    },
  };
}
