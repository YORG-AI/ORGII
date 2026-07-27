const transcriptSignatures = new Map<string, string>();
const MAX_TRANSCRIPT_SIGNATURES = 64;

/**
 * Remember the stable on-disk snapshot that produced the currently displayed
 * replay. The registry is deliberately tiny and process-local: only the one
 * open external session is polled, while a short LRU tail covers tab switches.
 */
export function rememberTranscriptSignature(
  sessionId: string,
  signature: string
): void {
  transcriptSignatures.delete(sessionId);
  transcriptSignatures.set(sessionId, signature);
  while (transcriptSignatures.size > MAX_TRANSCRIPT_SIGNATURES) {
    const oldest = transcriptSignatures.keys().next().value as
      | string
      | undefined;
    if (!oldest) break;
    transcriptSignatures.delete(oldest);
  }
}

export function getTranscriptSignature(sessionId: string): string | undefined {
  return transcriptSignatures.get(sessionId);
}

export function forgetTranscriptSignature(sessionId: string): void {
  transcriptSignatures.delete(sessionId);
}
