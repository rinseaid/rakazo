import { createHash } from "node:crypto";
import type { PrismaClient } from "./client.js";
import { ciphertextKeyId, decryptText } from "./content-crypto.js";
import { contentEncryptionOf } from "./content-encryption.js";
import { createPendingNativeConversationCandidate } from "./native-conversation-candidate.js";

/** Fits the private 8 MiB relay frame after base64 and account metadata. */
export const MAX_NATIVE_CONVERSATION_BYTES = 4 * 1024 * 1024;

export interface NativeConversationBinding {
  userId: string;
  spaceId: string;
  threadId: string;
  botId: string;
  helperNamespace: string;
  provider: string;
  credentialId: string;
  /** Generation of the credential actually loaded, not a later lookup. */
  accountGeneration: string;
  modelId: string;
  runtimeVersion: string;
  /** Stable private host protocol/image boundary, not an ephemeral host UUID. */
  hostBoundary: string;
  historyGeneration: number;
  /** Hash of actual system instructions, tools and context strategy. */
  contextBoundary: string;
}

export interface NativeConversationFence {
  runId: string;
  leaseOwner: string;
  leaseFence: number;
  /** Unique immutable AccountOperationHost id, checked against this run and actor. */
  hostId: string;
}

export interface NativeContextCursor {
  count: number;
  prefixHash: string;
}

/** Canonical message strings are supplied by the provider's one serialization path. */
export function nativeContextCursor(messages: readonly string[]): NativeContextCursor {
  if (messages.length > 10000 || messages.some((message) => typeof message !== "string"))
    throw new Error("Invalid native context cursor");
  return { count: messages.length, prefixHash: digest(messages) };
}

/** Count is only an index; exact prefix authentication is mandatory before sending a delta. */
export function nativeContextDelta(messages: readonly string[], cursor: NativeContextCursor) {
  validateCursor(cursor);
  if (messages.length < cursor.count) return undefined;
  const prefix = nativeContextCursor(messages.slice(0, cursor.count));
  return prefix.prefixHash === cursor.prefixHash ? messages.slice(cursor.count) : undefined;
}

export interface NativeConversationSnapshot {
  sessionId: string;
  bytes: Uint8Array;
  cursor: NativeContextCursor;
}

function digest(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function nativeConversationBindingId(binding: NativeConversationBinding): string {
  const values = [
    binding.userId,
    binding.spaceId,
    binding.threadId,
    binding.botId,
    binding.helperNamespace,
    binding.provider,
    binding.credentialId,
    binding.accountGeneration,
    binding.modelId,
    binding.runtimeVersion,
    binding.hostBoundary,
    binding.contextBoundary,
  ];
  if (
    values.some((value) => typeof value !== "string" || !value || value.length > 4096) ||
    !Number.isSafeInteger(binding.historyGeneration) ||
    binding.historyGeneration < 0
  )
    throw new Error("Invalid native conversation binding");
  return digest(["native-conversation-v1", ...values, binding.historyGeneration]);
}

function validateCursor(cursor: NativeContextCursor) {
  if (
    !cursor ||
    !Number.isSafeInteger(cursor.count) ||
    cursor.count < 0 ||
    cursor.count > 10000 ||
    typeof cursor.prefixHash !== "string" ||
    !/^[a-f0-9]{64}$/.test(cursor.prefixHash)
  )
    throw new Error("Invalid native context cursor");
}

function validateSnapshot(snapshot: NativeConversationSnapshot) {
  if (
    !snapshot ||
    typeof snapshot.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.sessionId) ||
    !(snapshot.bytes instanceof Uint8Array) ||
    snapshot.bytes.byteLength === 0 ||
    snapshot.bytes.byteLength > MAX_NATIVE_CONVERSATION_BYTES
  )
    throw new Error("Invalid native conversation snapshot");
  validateCursor(snapshot.cursor);
}

const location = (binding: NativeConversationBinding, id: string) => ({
  table: "native_conversation_states",
  column: "ciphertext",
  rowId: id,
  owner: JSON.stringify([binding.userId, binding.threadId, nativeConversationBindingId(binding)]),
});

type Transaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

async function lockScope(
  tx: Transaction,
  binding: NativeConversationBinding,
  fence: NativeConversationFence,
) {
  const now = new Date();
  if (!Number.isSafeInteger(fence.leaseFence) || fence.leaseFence < 0)
    throw new Error("Invalid native state fence");
  const run = await tx.run.updateMany({
    where: {
      id: fence.runId,
      userId: binding.userId,
      spaceId: binding.spaceId,
      threadId: binding.threadId,
      botId: binding.botId,
      status: "running",
      leaseOwner: fence.leaseOwner,
      leaseFence: fence.leaseFence,
      leaseExpiresAt: { gt: now },
    },
    data: { leaseFence: fence.leaseFence },
  });
  if (run.count !== 1) throw new Error("Native conversation run lease expired");
  const host = await tx.accountOperationHost.updateMany({
    where: {
      id: fence.hostId,
      userId: binding.userId,
      spaceId: binding.spaceId,
      operationId: fence.runId,
      cleanupRequestedAt: null,
      expiresAt: { gt: now },
    },
    data: { operationId: fence.runId },
  });
  if (host.count !== 1) throw new Error("Native conversation private host lease expired");
  const credential = await tx.userModelCredential.updateMany({
    where: {
      id: binding.credentialId,
      userId: binding.userId,
      provider: binding.provider,
      secretId: binding.accountGeneration,
    },
    data: { secretId: binding.accountGeneration },
  });
  if (credential.count !== 1) throw new Error("Native conversation account changed");
  const thread = await tx.thread.updateMany({
    where: {
      id: binding.threadId,
      spaceId: binding.spaceId,
      historyCompactionGeneration: binding.historyGeneration,
    },
    data: { historyCompactionGeneration: binding.historyGeneration },
  });
  if (thread.count !== 1) throw new Error("Native conversation context changed");
}

/**
 * Private server capability. Atomically consumes saved state before native mutation.
 * Missing/expired state never means pending tool calls can be resumed or replayed.
 */
export async function claimNativeConversation(
  prisma: PrismaClient,
  suppliedBinding: NativeConversationBinding,
  suppliedFence: NativeConversationFence,
) {
  const binding = { ...suppliedBinding };
  const fence = { ...suppliedFence };
  const bindingHash = nativeConversationBindingId(binding);
  // One slot per logical conversation, rather than accumulating a row for every context edit.
  const id = digest([
    "native-conversation-slot-v1",
    binding.userId,
    binding.spaceId,
    binding.threadId,
    binding.botId,
    binding.helperNamespace,
    binding.provider,
    binding.credentialId,
  ]);
  const encryption = contentEncryptionOf(prisma);
  if (!encryption) throw new Error("Native conversation encryption is unavailable");
  // Resolve a usable key before consuming saved state. Deliberately ignore encryptWrites.
  const key = await encryption.ring.current(binding.spaceId);
  if (key.spaceId !== binding.spaceId) throw new Error("Native conversation key scope mismatch");
  const claimed = await prisma.$transaction(async (tx) => {
    await lockScope(tx, binding, fence);
    const row = await tx.nativeConversationState.upsert({
      where: { id },
      create: {
        id,
        bindingHash,
        userId: binding.userId,
        spaceId: binding.spaceId,
        threadId: binding.threadId,
        botId: binding.botId,
        credentialId: binding.credentialId,
        accountGeneration: binding.accountGeneration,
        revision: 1,
      },
      update: { revision: { increment: 1 } },
    });
    if (row.id !== id) throw new Error("Native conversation row scope mismatch");
    for (const field of ["userId", "spaceId", "threadId", "botId", "credentialId"] as const) {
      if (row[field] !== binding[field]) throw new Error("Native conversation row scope mismatch");
    }
    if (row.claimHostId) {
      const active = await tx.accountOperationHost.findFirst({
        // A retained host row means destruction is unconfirmed, even after TTL/cleanup request.
        where: { id: row.claimHostId },
        select: { id: true },
      });
      if (active) throw new Error("Native conversation is already in use");
    }
    await tx.nativeConversationState.update({
      where: { id },
      data: {
        ciphertext: null,
        claimHostId: fence.hostId,
        bindingHash,
        accountGeneration: binding.accountGeneration,
      },
    });
    return row;
  });
  let snapshot: NativeConversationSnapshot | undefined;
  if (claimed.ciphertext && claimed.bindingHash === bindingHash) {
    if (claimed.ciphertext.length > 8 * 1024 * 1024)
      throw new Error("Native conversation ciphertext is too large");
    const keyId = ciphertextKeyId(claimed.ciphertext);
    if (!keyId) throw new Error("Native conversation plaintext is forbidden");
    const oldKey = await encryption.ring.byId(keyId);
    if (oldKey.spaceId !== binding.spaceId)
      throw new Error("Native conversation key scope mismatch");
    const plaintext = decryptText(oldKey, location(binding, id), claimed.ciphertext);
    const saved = JSON.parse(plaintext) as {
      version: number;
      sessionId: string;
      data: string;
      cursor: NativeContextCursor;
    };
    if (
      saved.version !== 1 ||
      typeof saved.data !== "string" ||
      saved.data.length > Math.ceil(MAX_NATIVE_CONVERSATION_BYTES / 3) * 4
    )
      throw new Error("Invalid native conversation payload");
    const bytes = Buffer.from(saved.data, "base64");
    if (bytes.toString("base64") !== saved.data)
      throw new Error("Invalid native conversation encoding");
    snapshot = { sessionId: saved.sessionId, bytes, cursor: saved.cursor };
    validateSnapshot(snapshot);
  }
  let prepared = false;
  const capability = {
    snapshot,
    /** Prepare only in memory; finalizeRun promotes it with committed application history. */
    prepareCompleted(next: Omit<NativeConversationSnapshot, "cursor">) {
      if (prepared) throw new Error("Native conversation claim is already prepared");
      prepared = true;
      return createPendingNativeConversationCandidate({
        id,
        binding,
        fence,
        bindingHash,
        revision: claimed.revision,
        key,
        snapshot: next,
      });
    },
  };
  Object.defineProperty(capability, "snapshot", { enumerable: false });
  return capability;
}
