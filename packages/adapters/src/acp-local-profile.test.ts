import { chmod, lstat, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createAcpLocalProfile } from "./acp-local-profile.js";

describe("private native account staging", () => {
  it("isolates two accounts and creates owner-only files", async () => {
    const a = await createAcpLocalProfile(os.tmpdir());
    const b = await createAcpLocalProfile(os.tmpdir());
    try {
      await a.writePrivate("provider/token.json", Buffer.from("fake-account-a"));
      await b.writePrivate("provider/token.json", Buffer.from("fake-account-b"));
      expect(a.root).not.toBe(b.root);
      expect(Buffer.from((await a.readPrivate("provider/token.json", 1024))!).toString()).toBe(
        "fake-account-a",
      );
      expect((await lstat(path.join(a.root, "provider/token.json"))).mode & 0o777).toBe(0o600);
      expect((await lstat(a.root)).mode & 0o777).toBe(0o700);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  it("refuses traversal and credential overwrites", async () => {
    const profile = await createAcpLocalProfile(os.tmpdir());
    try {
      for (const name of ["../outside", "/absolute", "a/../b", "a\\b", "C:/account", "./a"])
        await expect(profile.writePrivate(name, Buffer.from("fixture"))).rejects.toThrow();
      await profile.writePrivate("token", Buffer.from("original"));
      await expect(profile.writePrivate("token", Buffer.from("replacement"))).rejects.toThrow();
      expect((await readFile(path.join(profile.root, "token"))).toString()).toBe("original");
    } finally {
      await profile.dispose();
    }
  });

  it("rejects symlinks, oversized files and permissive file modes", async () => {
    const profile = await createAcpLocalProfile(os.tmpdir());
    const outside = await mkdtemp(path.join(os.tmpdir(), "acp-outside-"));
    try {
      await symlink(outside, path.join(profile.root, "escape"));
      await expect(profile.writePrivate("escape/token", Buffer.from("fixture"))).rejects.toThrow();
      await profile.writePrivate("token", Buffer.from("fixture"));
      await symlink(path.join(profile.root, "token"), path.join(profile.root, "link"));
      await expect(profile.readPrivate("link", 100)).rejects.toThrow();
      await expect(profile.readPrivate("token", 2)).rejects.toThrow();
      await chmod(path.join(profile.root, "token"), 0o644);
      await expect(profile.readPrivate("token", 100)).rejects.toThrow();
    } finally {
      await profile.dispose();
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("reads exactly 4MiB of opaque state and rejects a larger requested bound", async () => {
    const profile = await createAcpLocalProfile(os.tmpdir());
    const bytes = Buffer.alloc(4 * 1024 * 1024, 19);
    try {
      await profile.writePrivate("conversations/fixture.db", bytes);
      const loaded = await profile.readPrivate("conversations/fixture.db", bytes.length);
      expect(Buffer.from(loaded!).equals(bytes)).toBe(true);
      await expect(
        profile.readPrivate("conversations/fixture.db", bytes.length + 1),
      ).rejects.toThrow();
    } finally {
      await profile.dispose();
    }
  });
  it("cleans up idempotently and refuses reuse", async () => {
    const profile = await createAcpLocalProfile(os.tmpdir());
    await profile.dispose();
    await profile.dispose();
    await expect(lstat(profile.root)).rejects.toThrow();
    await expect(profile.writePrivate("token", Buffer.from("fixture"))).rejects.toThrow();
  });
});
