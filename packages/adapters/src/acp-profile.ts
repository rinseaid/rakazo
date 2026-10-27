import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import { MAX_NATIVE_PROFILE_BYTES, parseNativeModelProfile } from "./model-native-auth.js";

/** Private filesystem belonging to one leased runtime, supplied by its computer adapter. */
export interface AcpProfileFiles {
  /** Must be exclusive-create with owner-only permissions; never follow symlinks. */
  writePrivate(path: string, bytes: Uint8Array): Promise<void>;
  /** Must reject symlinks and files exceeding maxBytes. */
  readPrivate(path: string, maxBytes: number): Promise<Uint8Array | undefined>;
  /** Removes only this lease's files, after its process has stopped. */
  dispose(): Promise<void>;
}

const MAX_PROFILE_BYTES = MAX_NATIVE_PROFILE_BYTES;

/**
 * Persist an agent-owned login using Rakazo's existing encrypted SecretStore.
 * It is opaque native state, not an invented access token or a claim of OAuth validity.
 * No global home directory, environment token lookup, or automatic account migration.
 */
export async function restoreAcpProfile(input: {
  store: Pick<SecretStore, "load">;
  secretRef: string;
  recordId: string;
  allowedPaths: readonly string[];
  files: AcpProfileFiles;
  signal?: AbortSignal;
}): Promise<void> {
  try {
    input.signal?.throwIfAborted();
    const allowed = allowedProfilePaths(input.allowedPaths);
    const serialized = await input.store.load(input.secretRef, {
      recordId: input.recordId,
      signal: input.signal,
    });
    if (Buffer.byteLength(serialized) > MAX_PROFILE_BYTES) throw new Error("Profile is too large");
    const value = parseNativeModelProfile(JSON.parse(serialized));
    const entries = value.files.map((entry) => {
      if (!allowed.has(entry.path)) throw new Error("Unexpected account profile path");
      return { path: entry.path, bytes: Buffer.from(entry.data, "utf8") };
    });
    // Validate the complete envelope before writing anything into the leased computer.
    if (!entries.length) throw new Error("Empty profile");
    for (const entry of entries) {
      input.signal?.throwIfAborted();
      await input.files.writePrivate(entry.path, entry.bytes);
    }
    input.signal?.throwIfAborted();
  } catch {
    await input.files.dispose().catch(() => undefined);
    throw new Error("ACP account profile could not be restored");
  }
}

/** Snapshot only after the hosted process has exited and flushed its refresh state. */
export async function persistAcpProfile(input: {
  store: Pick<SecretStore, "put" | "delete">;
  recordId: string;
  context: AdapterContext;
  allowedPaths: readonly string[];
  requiredPaths: readonly string[];
  files: AcpProfileFiles;
  previousRef?: string;
  /** Must compare-and-swap the existing connection's ref; stale writers cannot overwrite it. */
  commit(nextRef: string, previousRef: string | undefined): Promise<boolean>;
}): Promise<{ saved: true; previousRetired: boolean }> {
  let nextRef: string | undefined;
  let failure: Error | undefined;
  let saved: { saved: true; previousRetired: boolean } | undefined;
  let committed = false;
  let commitUncertain = false;
  try {
    const allowed = allowedProfilePaths(input.allowedPaths);
    if (input.requiredPaths.some((path) => !allowed.has(path)))
      throw new Error("Invalid required profile path");
    const files: Array<{ path: string; data: string }> = [];
    let size = 0;
    for (const path of allowed) {
      input.context.signal?.throwIfAborted();
      const bytes = await input.files.readPrivate(path, MAX_PROFILE_BYTES);
      if (!bytes) {
        if (input.requiredPaths.includes(path)) throw new Error("Required account state missing");
        continue;
      }
      size += bytes.byteLength;
      if (size > MAX_PROFILE_BYTES) throw new Error("Profile is too large");
      files.push({ path, data: new TextDecoder("utf-8", { fatal: true }).decode(bytes) });
    }
    if (!files.length) throw new Error("Empty profile");
    const serialized = JSON.stringify(parseNativeModelProfile({ version: 1, files }));
    if (Buffer.byteLength(serialized) > MAX_PROFILE_BYTES) throw new Error("Profile is too large");
    input.context.signal?.throwIfAborted();
    const secret = await input.store.put(serialized, input.context, { recordId: input.recordId });
    nextRef = secret.ref;
    input.context.signal?.throwIfAborted();
    commitUncertain = true;
    committed = await input.commit(nextRef, input.previousRef);
    commitUncertain = false;
    if (!committed) throw new Error("Account state changed concurrently");
    let previousRetired = true;
    if (input.previousRef && input.previousRef !== nextRef) {
      try {
        await input.store.delete(input.previousRef, input.recordId);
      } catch {
        previousRetired = false;
      }
    }
    saved = { saved: true, previousRetired };
  } catch {
    // Delete only after a definite failed CAS; a thrown commit may already have saved the new ref.
    if (nextRef && !committed && !commitUncertain)
      await input.store.delete(nextRef, input.recordId).catch(() => undefined);
    failure = new Error("ACP account profile could not be saved");
  }
  try {
    await input.files.dispose();
  } catch {
    failure ??= new Error(
      committed
        ? "ACP account saved but temporary profile cleanup failed"
        : "ACP temporary profile cleanup failed",
    );
  }
  if (failure) throw failure;
  if (!saved) throw new Error("ACP account profile could not be saved");
  return saved;
}

function allowedProfilePaths(paths: readonly string[]): ReadonlySet<string> {
  const result = new Set<string>();
  for (const path of paths) {
    if (
      !path ||
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      result.has(path)
    )
      throw new Error("Invalid account profile path");
    result.add(path);
  }
  if (!result.size) throw new Error("Account profile paths are required");
  return result;
}
