// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  GIF_LIMITS,
  getGifLimitViolation,
  parseGifMetadata,
  readGifLogicalScreen,
} from "../gifMetadata";
import { optimizeImage } from "../imageOptimizer";

function pushUint16Le(bytes: number[], value: number): void {
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function createGif(
  width: number,
  height: number,
  frameCount: number
): Uint8Array {
  const bytes = Array.from(new TextEncoder().encode("GIF89a"));
  pushUint16Le(bytes, width);
  pushUint16Le(bytes, height);
  // No global color table; background and aspect ratio are zero.
  bytes.push(0, 0, 0);

  for (let frame = 0; frame < frameCount; frame += 1) {
    bytes.push(0x2c);
    pushUint16Le(bytes, 0);
    pushUint16Le(bytes, 0);
    pushUint16Le(bytes, width);
    pushUint16Le(bytes, height);
    bytes.push(0); // No local color table.
    bytes.push(2); // LZW minimum code size.
    bytes.push(1, 0, 0); // One data byte, followed by block terminator.
  }
  bytes.push(0x3b);
  return Uint8Array.from(bytes);
}

describe("GIF metadata inspection", () => {
  it("returns null for non-GIF data", () => {
    expect(
      readGifLogicalScreen(new TextEncoder().encode("not-gif-data"))
    ).toBeNull();
    expect(
      parseGifMetadata(new TextEncoder().encode("not-gif-data"))
    ).toBeNull();
  });

  it("reads dimensions and counts real image blocks", () => {
    const gif = createGif(320, 180, 3);

    expect(readGifLogicalScreen(gif.subarray(0, 13))).toEqual({
      width: 320,
      height: 180,
    });
    expect(parseGifMetadata(gif)).toEqual({
      width: 320,
      height: 180,
      frameCount: 3,
      estimatedDecodedBytes: 320 * 180 * 4 * 3,
    });
  });

  it("rejects every bounded-resource violation", () => {
    const safe = {
      width: 320,
      height: 180,
      frameCount: 30,
      estimatedDecodedBytes: 320 * 180 * 4 * 30,
    };
    expect(getGifLimitViolation(safe, 500_000)).toBeNull();
    expect(getGifLimitViolation(safe, GIF_LIMITS.MAX_FILE_SIZE + 1)).toBe(
      "FILE_TOO_LARGE"
    );
    expect(
      getGifLimitViolation({ ...safe, width: GIF_LIMITS.MAX_DIMENSION + 1 }, 1)
    ).toBe("DIMENSION_TOO_LARGE");
    expect(
      getGifLimitViolation(
        { ...safe, frameCount: GIF_LIMITS.MAX_FRAME_COUNT + 1 },
        1
      )
    ).toBe("TOO_MANY_FRAMES");
    expect(
      getGifLimitViolation(
        {
          ...safe,
          estimatedDecodedBytes: GIF_LIMITS.MAX_ESTIMATED_DECODED_BYTES + 1,
        },
        1
      )
    ).toBe("DECODED_SIZE_TOO_LARGE");
  });

  it("rejects truncated GIF blocks instead of guessing a frame count", () => {
    const truncated = createGif(10, 10, 1).subarray(0, 20);
    expect(() => parseGifMetadata(truncated)).toThrow(
      /truncated|terminator|incomplete/u
    );
  });

  it("rejects an unsafe animation before invoking the browser image decoder", async () => {
    const gif = createGif(2048, 2048, 3);
    const file = new File([gif.buffer as ArrayBuffer], "oversized.gif", {
      type: "image/gif",
    });

    await expect(optimizeImage(file)).rejects.toMatchObject({
      code: "GIF_LIMIT_EXCEEDED",
    });
  });
});
