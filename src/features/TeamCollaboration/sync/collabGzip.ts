/**
 * Gzip + canonical serialization helpers for the segments data plane (§7).
 *
 * Event segments travel as client-gzipped JSON (`payload_gz bytea` on the
 * server); PostgREST transports them base64-encoded. Both the renderer and
 * Node ≥18 (vitest) provide `CompressionStream` / `DecompressionStream`
 * natively, so no zlib seam is needed — tests exercise the real codec.
 *
 * `segmentCanonicalJson` is the single canonical byte representation of a
 * segment's event array: it feeds BOTH the gzip payload and `segment_hash`,
 * so the server-side idempotency check (identical PK + identical hash ⇒
 * retry no-op) compares exactly what was shipped.
 */

async function pipeThroughStream(
  bytes: Uint8Array,
  stream: CompressionStream | DecompressionStream
): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  // Copy into a fresh ArrayBuffer-backed view: the DOM typings reject
  // Uint8Array<ArrayBufferLike> as a BufferSource.
  void writer.write(new Uint8Array(bytes));
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

const BASE64_CHUNK = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += BASE64_CHUNK) {
    binary += String.fromCharCode(
      ...bytes.subarray(index, index + BASE64_CHUNK)
    );
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/**
 * Canonical JSON bytes of a segment payload. Plain JSON.stringify: the
 * events come from a single serde serialization path so key order is stable
 * within a client; a cross-restart order drift only costs one idempotency
 * miss (hash mismatch → ORGII_CONFLICT → OCC re-anchor, self-healing).
 */
export function segmentCanonicalJson(value: unknown): string {
  return JSON.stringify(value);
}

/** sha256 hex of the canonical segment bytes — the wire `segment_hash`. */
export async function computeSegmentHash(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(segmentCanonicalJson(value))
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

/** JSON → gzip → base64 (the client half of `payload_gz`). */
export async function gzipJsonToBase64(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(segmentCanonicalJson(value));
  const compressed = await pipeThroughStream(
    bytes,
    new CompressionStream("gzip")
  );
  return bytesToBase64(compressed);
}

/** base64 → gunzip → JSON (the client half of reading `payload_gz`). */
export async function gunzipBase64ToJson(base64: string): Promise<unknown> {
  const compressed = base64ToBytes(base64);
  const bytes = await pipeThroughStream(
    compressed,
    new DecompressionStream("gzip")
  );
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
