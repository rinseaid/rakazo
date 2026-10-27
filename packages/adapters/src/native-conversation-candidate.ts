import type {
  NativeContextCursor,
  NativeConversationCommitCandidate,
  PendingNativeConversationCandidate,
} from "@rakazo/db";
import { nativeContextCursor } from "@rakazo/db";
import { googleAcpCanonicalAssistantText } from "./google-acp-provider.js";

/** In-memory only handoff from a clean native close to the owning executor run. */
export interface NativeConversationRunCandidate {
  provider: string;
  modelId: string;
  sourceMessageId: string;
  canonicalPrefix: readonly string[];
  pending: PendingNativeConversationCandidate;
}

const candidateSinks = new WeakMap<object, (candidate: NativeConversationRunCandidate) => void>();

export function registerNativeConversationCandidateSink(
  request: object,
  sink: (candidate: NativeConversationRunCandidate) => void,
) {
  candidateSinks.set(request, sink);
}

export function forwardNativeConversationCandidateSink(
  from: object,
  to: object,
  isEligible: () => boolean = () => true,
) {
  const sink = candidateSinks.get(from);
  if (sink)
    candidateSinks.set(to, (candidate) => {
      if (isEligible()) sink(candidate);
      else discardNativeConversationRunCandidate(candidate);
    });
}

export function emitNativeConversationCandidate(
  request: object,
  candidate: NativeConversationRunCandidate,
) {
  const sink = candidateSinks.get(request);
  if (sink) sink(candidate);
  else discardNativeConversationRunCandidate(candidate);
}

export function discardNativeConversationRunCandidate(candidate: NativeConversationRunCandidate) {
  candidate.pending.discard();
}

export function bindNativeConversationCandidate(
  candidate: NativeConversationRunCandidate,
  finalAssistantHistory: readonly string[],
): NativeConversationCommitCandidate {
  const finalMessages = finalAssistantHistory.map((text) => googleAcpCanonicalAssistantText(text));
  const cursor: NativeContextCursor = nativeContextCursor([
    ...candidate.canonicalPrefix,
    ...finalMessages,
  ]);
  return candidate.pending.bindCursor(cursor);
}
