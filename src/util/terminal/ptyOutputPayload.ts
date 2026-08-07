/**
 * Payload of `pty-output-{sessionId}` Tauri events.
 *
 * The backend emits `{ b64, byte_count, seq }`. The `bytes` (JSON integer
 * array) and `data` (plain string) forms are legacy fallbacks kept for
 * hot-reload version skew between webview and backend.
 */
export interface PtyOutputPayload {
  /** Base64-encoded raw PTY bytes (current backend). */
  b64?: string;
  /** Stream offset of this chunk's first byte; aligns with attach covers_seq. */
  seq?: number;
  byte_count?: number;
  /** Legacy: raw bytes as a JSON integer array. */
  bytes?: number[];
  /** Legacy: pre-decoded string. */
  data?: string;
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Raw bytes of the chunk, or null when the payload carries no byte form
 * (callers then fall back to the string `data` field).
 */
export function ptyPayloadBytes(payload: PtyOutputPayload): Uint8Array | null {
  if (payload.b64) {
    return base64ToBytes(payload.b64);
  }
  if (payload.bytes && payload.bytes.length > 0) {
    return new Uint8Array(payload.bytes);
  }
  return null;
}
