import { describe, expect, it } from "vitest";

import {
  PTY_FRAME_HEADER_BYTES,
  decodePtyOutputFrame,
} from "../ptyOutputFrame";

/**
 * Mirrors `encode_pty_output_frame` in
 * `src-tauri/crates/terminal/src/pty_commands/pty/output_frame.rs`. Kept here
 * rather than imported so a drift in either direction fails a test instead of
 * being papered over by a shared helper.
 */
function encodeFrame(seq: number, payload: number[]): ArrayBuffer {
  const frame = new Uint8Array(PTY_FRAME_HEADER_BYTES + payload.length);
  const view = new DataView(frame.buffer);
  view.setUint32(0, Math.floor(seq / 2 ** 32));
  view.setUint32(4, seq >>> 0);
  frame.set(payload, PTY_FRAME_HEADER_BYTES);
  return frame.buffer;
}

describe("decodePtyOutputFrame", () => {
  it("splits the stream offset from the payload", () => {
    const frame = decodePtyOutputFrame(encodeFrame(1234, [0x68, 0x69]));

    expect(frame?.seq).toBe(1234);
    expect(Array.from(frame?.bytes ?? [])).toEqual([0x68, 0x69]);
  });

  it("reads offsets beyond 32 bits", () => {
    const seq = 2 ** 32 + 7;

    expect(decodePtyOutputFrame(encodeFrame(seq, [0x41]))?.seq).toBe(seq);
  });

  it("accepts a Uint8Array view as well as an ArrayBuffer", () => {
    const buffer = encodeFrame(9, [0x41, 0x42]);

    expect(decodePtyOutputFrame(new Uint8Array(buffer))?.seq).toBe(9);
  });

  it("keeps payload bytes verbatim so split codepoints survive", () => {
    // Leading two bytes of U+2500; the streaming TextDecoder reassembles the
    // third from the next frame, so framing must not normalize or drop them.
    const frame = decodePtyOutputFrame(encodeFrame(0, [0xe2, 0x94]));

    expect(Array.from(frame?.bytes ?? [])).toEqual([0xe2, 0x94]);
  });

  it("reports an empty payload rather than treating it as an error", () => {
    const frame = decodePtyOutputFrame(encodeFrame(5, []));

    expect(frame?.seq).toBe(5);
    expect(frame?.bytes.length).toBe(0);
  });

  it("rejects a frame too short to hold a header", () => {
    expect(decodePtyOutputFrame(new Uint8Array([1, 2, 3]).buffer)).toBeNull();
  });

  it("decodes a view into a larger buffer without reading past it", () => {
    // Guards the DataView construction: a subarray carries a non-zero
    // byteOffset, and using the underlying buffer's origin would read the
    // wrong eight bytes as the stream offset.
    const backing = new Uint8Array(4 + PTY_FRAME_HEADER_BYTES + 1);
    backing.set(new Uint8Array(encodeFrame(77, [0x5a])), 4);

    const frame = decodePtyOutputFrame(
      backing.subarray(4, 4 + PTY_FRAME_HEADER_BYTES + 1)
    );

    expect(frame?.seq).toBe(77);
    expect(Array.from(frame?.bytes ?? [])).toEqual([0x5a]);
  });
});
