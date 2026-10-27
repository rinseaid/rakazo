import type { Prisma } from "./client.js";
import type { DataKey } from "./content-crypto.js";
import { encryptText } from "./content-crypto.js";
import type {
  NativeContextCursor,
  NativeConversationBinding,
  NativeConversationFence,
  NativeConversationSnapshot,
} from "./native-conversation-state.js";
import {
  MAX_NATIVE_CONVERSATION_BYTES,
  nativeConversationBindingId,
} from "./native-conversation-state.js";

declare const pendingBrand: unique symbol;
declare const commitBrand: unique symbol;

export interface PendingNativeConversationCandidate {
  readonly [pendingBrand]: true;
  bindCursor(cursor: NativeContextCursor): NativeConversationCommitCandidate;
  discard(): void;
}

/** Opaque, one-shot value accepted only by the run history commit transaction. */
export interface NativeConversationCommitCandidate {
  readonly [commitBrand]: true;
}

interface CandidateDetails {
  id: string;
  binding: NativeConversationBinding;
  fence: NativeConversationFence;
  bindingHash: string;
  revision: number;
  ciphertext: string;
}

const candidates = new WeakMap<object, CandidateDetails>();

/** Create a private deferred candidate. It contains no durable state until finalizeRun commits it. */
export function createPendingNativeConversationCandidate(input: {
  id: string;
  binding: NativeConversationBinding;
  fence: NativeConversationFence;
  bindingHash: string;
  revision: number;
  key: DataKey;
  snapshot: Omit<NativeConversationSnapshot, "cursor">;
}): PendingNativeConversationCandidate {
  const { id, binding, fence, snapshot, key } = input;
  if (
    !snapshot ||
    typeof snapshot.sessionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(snapshot.sessionId) ||
    !(snapshot.bytes instanceof Uint8Array) ||
    snapshot.bytes.byteLength === 0 ||
    snapshot.bytes.byteLength > MAX_NATIVE_CONVERSATION_BYTES
  )
    throw new Error("Invalid native conversation candidate");
  const sessionId = snapshot.sessionId;
  const bytes = Buffer.from(snapshot.bytes);
  if (key.spaceId !== binding.spaceId) throw new Error("Native conversation key scope mismatch");
  let bound = false;
  let discarded = false;
  return Object.freeze({
    bindCursor(cursor: NativeContextCursor) {
      if (bound) throw new Error("Native conversation candidate is already bound");
      if (discarded) throw new Error("Native conversation candidate was discarded");
      if (
        !cursor ||
        !Number.isSafeInteger(cursor.count) ||
        cursor.count < 0 ||
        cursor.count > 10000 ||
        typeof cursor.prefixHash !== "string" ||
        !/^[a-f0-9]{64}$/.test(cursor.prefixHash)
      )
        throw new Error("Invalid native conversation cursor");
      bound = true;
      let ciphertext: string;
      try {
        ciphertext = encryptText(
          key,
          {
            table: "native_conversation_states",
            column: "ciphertext",
            rowId: id,
            owner: JSON.stringify([
              binding.userId,
              binding.threadId,
              nativeConversationBindingId(binding),
            ]),
          },
          JSON.stringify({
            version: 1,
            sessionId,
            data: bytes.toString("base64"),
            cursor,
          }),
        );
      } finally {
        bytes.fill(0);
      }
      const token = Object.freeze({}) as NativeConversationCommitCandidate;
      candidates.set(token, {
        id,
        binding,
        fence,
        bindingHash: input.bindingHash,
        revision: input.revision,
        ciphertext,
      });
      return token;
    },
    discard() {
      if (bound || discarded) return;
      discarded = true;
      bytes.fill(0);
    },
  }) as PendingNativeConversationCandidate;
}

/** Promote only inside the matching successful run-history transaction. */
export async function promoteNativeConversationCandidate(
  tx: Prisma.TransactionClient,
  candidate: NativeConversationCommitCandidate,
  input: { runId: string; leaseOwner: string; leaseFence: number; userId: string },
): Promise<boolean> {
  const details = candidates.get(candidate as object);
  if (!details) throw new Error("Invalid native conversation commit candidate");
  const { binding, fence } = details;
  if (
    fence.runId !== input.runId ||
    fence.leaseOwner !== input.leaseOwner ||
    fence.leaseFence !== input.leaseFence ||
    binding.userId !== input.userId
  )
    return false;
  const [thread, credential] = await Promise.all([
    tx.thread.findFirst({
      where: {
        id: binding.threadId,
        spaceId: binding.spaceId,
        historyCompactionGeneration: binding.historyGeneration,
      },
      select: { id: true },
    }),
    tx.userModelCredential.findFirst({
      where: {
        id: binding.credentialId,
        userId: binding.userId,
        provider: binding.provider,
        secretId: binding.accountGeneration,
      },
      select: { id: true },
    }),
  ]);
  if (!thread || !credential) return false;
  const updated = await tx.nativeConversationState.updateMany({
    where: {
      id: details.id,
      userId: binding.userId,
      spaceId: binding.spaceId,
      threadId: binding.threadId,
      botId: binding.botId,
      credentialId: binding.credentialId,
      bindingHash: details.bindingHash,
      revision: details.revision,
      claimHostId: fence.hostId,
      ciphertext: null,
    },
    data: { ciphertext: details.ciphertext, claimHostId: null },
  });
  return updated.count === 1;
}

export function discardNativeConversationCandidate(candidate: NativeConversationCommitCandidate) {
  candidates.delete(candidate as object);
}
