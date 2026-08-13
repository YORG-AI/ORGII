/**
 * Lightweight GIF metadata parsing used before Chromium is allowed to decode
 * an uploaded image. Compressed GIF size alone is not a useful memory bound:
 * a small file can expand into many full RGBA frames.
 */

export const GIF_LIMITS = {
  /** Keep the temporary inspection buffer bounded. */
  MAX_FILE_SIZE: 8 * 1024 * 1024,
  /** Avoid oversized compositor surfaces even for short animations. */
  MAX_DIMENSION: 2048,
  /** Bound pathological tiny-frame animations. */
  MAX_FRAME_COUNT: 120,
  /** Conservative upper bound: logical-screen RGBA bytes multiplied by frames. */
  MAX_ESTIMATED_DECODED_BYTES: 32 * 1024 * 1024,
} as const;

export interface GifMetadata {
  width: number;
  height: number;
  frameCount: number;
  estimatedDecodedBytes: number;
}

export type GifLimitViolation =
  | "FILE_TOO_LARGE"
  | "DIMENSION_TOO_LARGE"
  | "TOO_MANY_FRAMES"
  | "DECODED_SIZE_TOO_LARGE";

function hasGifSignature(bytes: Uint8Array): boolean {
  if (bytes.length < 6) return false;
  const version = String.fromCharCode(...bytes.subarray(0, 6));
  return version === "GIF87a" || version === "GIF89a";
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

/** Read only the GIF signature and logical screen size from a short prefix. */
export function readGifLogicalScreen(
  bytes: Uint8Array
): { width: number; height: number } | null {
  if (!hasGifSignature(bytes)) return null;
  if (bytes.length < 13) throw new Error("GIF header is truncated");

  const width = readUint16Le(bytes, 6);
  const height = readUint16Le(bytes, 8);
  if (width === 0 || height === 0) {
    throw new Error("GIF has invalid logical screen dimensions");
  }
  return { width, height };
}

function skipSubBlocks(bytes: Uint8Array, initialOffset: number): number {
  let offset = initialOffset;
  while (offset < bytes.length) {
    const blockSize = bytes[offset];
    offset += 1;
    if (blockSize === 0) return offset;
    offset += blockSize;
    if (offset > bytes.length) throw new Error("GIF data block is truncated");
  }
  throw new Error("GIF data block has no terminator");
}

/**
 * Count image descriptors without decoding pixel data. The parser walks GIF
 * blocks so marker-like bytes inside compressed frame data are never counted.
 */
export function parseGifMetadata(bytes: Uint8Array): GifMetadata | null {
  const logicalScreen = readGifLogicalScreen(bytes);
  if (!logicalScreen) return null;

  const globalColorTablePacked = bytes[10];
  const hasGlobalColorTable = (globalColorTablePacked & 0x80) !== 0;
  const globalColorTableBytes = hasGlobalColorTable
    ? 3 * 2 ** ((globalColorTablePacked & 0x07) + 1)
    : 0;
  let offset = 13 + globalColorTableBytes;
  let frameCount = 0;
  let foundTrailer = false;

  while (offset < bytes.length) {
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0x3b) {
      foundTrailer = true;
      break;
    }

    if (marker === 0x21) {
      // Extension label followed by a standard sub-block chain.
      if (offset >= bytes.length) throw new Error("GIF extension is truncated");
      offset += 1;
      offset = skipSubBlocks(bytes, offset);
      continue;
    }

    if (marker === 0x2c) {
      // Image descriptor: left, top, width, height, packed flags.
      if (offset + 9 > bytes.length) {
        throw new Error("GIF image descriptor is truncated");
      }
      const packed = bytes[offset + 8];
      offset += 9;
      frameCount += 1;

      if ((packed & 0x80) !== 0) {
        const localColorTableBytes = 3 * 2 ** ((packed & 0x07) + 1);
        offset += localColorTableBytes;
      }
      // LZW minimum code size, then compressed image-data sub-blocks.
      if (offset >= bytes.length)
        throw new Error("GIF image data is truncated");
      offset += 1;
      offset = skipSubBlocks(bytes, offset);
      continue;
    }

    throw new Error(
      `GIF contains an unknown block marker: 0x${marker.toString(16)}`
    );
  }

  if (!foundTrailer || frameCount === 0) {
    throw new Error("GIF is incomplete or contains no frames");
  }

  const estimatedDecodedBytes =
    logicalScreen.width * logicalScreen.height * 4 * frameCount;
  return {
    ...logicalScreen,
    frameCount,
    estimatedDecodedBytes,
  };
}

export function getGifLimitViolation(
  metadata: Pick<
    GifMetadata,
    "width" | "height" | "frameCount" | "estimatedDecodedBytes"
  >,
  fileSize: number
): GifLimitViolation | null {
  if (fileSize > GIF_LIMITS.MAX_FILE_SIZE) return "FILE_TOO_LARGE";
  if (
    metadata.width > GIF_LIMITS.MAX_DIMENSION ||
    metadata.height > GIF_LIMITS.MAX_DIMENSION
  ) {
    return "DIMENSION_TOO_LARGE";
  }
  if (metadata.frameCount > GIF_LIMITS.MAX_FRAME_COUNT) {
    return "TOO_MANY_FRAMES";
  }
  if (metadata.estimatedDecodedBytes > GIF_LIMITS.MAX_ESTIMATED_DECODED_BYTES) {
    return "DECODED_SIZE_TOO_LARGE";
  }
  return null;
}
