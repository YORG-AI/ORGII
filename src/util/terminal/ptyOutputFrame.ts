/**
 * Binary framing for `attach_pty_output_channel`.
 *
 * The backend delivers terminal output over a Tauri channel as
 * `[8-byte big-endian stream offset][raw PTY bytes]`. The offset lines a chunk
 * up against the restore snapshot's `covers_seq`; the payload length is the
 * chunk's byte count for flow control. Both were separate JSON fields on the
 * `pty-output-{id}` event transport, which had to base64 the payload and route
 * it through a JavaScript source string the webview then parsed.
 */

/** Bytes of big-endian stream offset prefixed to every frame. */
export const PTY_FRAME_HEADER_BYTES = 8;

export interface PtyOutputFrame {
  /** Stream offset of the frame's first byte. */
  seq: number;
  /** Raw PTY bytes, aliasing the frame buffer without copying. */
  bytes: Uint8Array;
}

/**
 * Decode one output frame, or `null` when the payload is too short to carry a
 * header — a truncated frame is dropped rather than mis-parsed into a bogus
 * stream offset that would silently discard live output during restore.
 */
export function decodePtyOutputFrame(
  frame: ArrayBuffer | Uint8Array
): PtyOutputFrame | null {
  const bytes = frame instanceof Uint8Array ? frame : new Uint8Array(frame);
  if (bytes.byteLength < PTY_FRAME_HEADER_BYTES) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Two 32-bit halves rather than getBigUint64: the offset is a byte count that
  // stays well inside Number's exact-integer range, and allocating a BigInt per
  // chunk only to convert it back is pure overhead on the hot path.
  const seq = view.getUint32(0) * 2 ** 32 + view.getUint32(4);

  return { seq, bytes: bytes.subarray(PTY_FRAME_HEADER_BYTES) };
}
