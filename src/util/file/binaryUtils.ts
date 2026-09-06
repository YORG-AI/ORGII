/**
 * Binary File Utilities
 *
 * Shared helpers for turning raw file bytes into a `src` an `<img>` can show.
 */

/** Chunk size for the base64 fallback: keeps `fromCharCode` argument counts safe. */
const BASE64_CHUNK_BYTES = 0x8000;

/**
 * Convert a Uint8Array to a base64 data URL.
 *
 * Fallback only. A data URL keeps ~2.7x the file resident (a binary string
 * plus a base64 string, both larger than the bytes) for as long as the `src`
 * lives, so callers go through `uint8ArrayToImageUrl` instead.
 */
function uint8ArrayToDataUrl(data: Uint8Array, mimeType: string): string {
  let binary = "";
  for (let offset = 0; offset < data.byteLength; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(
      ...data.subarray(offset, offset + BASE64_CHUNK_BYTES)
    );
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/**
 * `Blob` only accepts views over a real `ArrayBuffer`. File bytes from the
 * fs plugin always are; anything backed by a `SharedArrayBuffer` is copied.
 */
function toBlobPart(data: Uint8Array): Uint8Array<ArrayBuffer> {
  if (data.buffer instanceof ArrayBuffer) {
    return data as Uint8Array<ArrayBuffer>;
  }
  return new Uint8Array(data);
}

function canUseObjectUrls(): boolean {
  return (
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof Blob !== "undefined"
  );
}

/**
 * Turn raw image bytes into a `src` for an `<img>`.
 *
 * Wraps the bytes in a Blob and hands back an object URL, so exactly one copy
 * of the file stays resident (the Blob) and WebKit decodes straight from it.
 * The URL is owned by the caller: pass it to `releaseImageUrl` when the image
 * is replaced or unmounted, or the Blob outlives the element.
 *
 * Hosts without object URLs (non-browser test environments) get a data URL,
 * which `releaseImageUrl` treats as a no-op.
 */
export function uint8ArrayToImageUrl(
  data: Uint8Array,
  mimeType: string
): string {
  if (!canUseObjectUrls()) {
    return uint8ArrayToDataUrl(data, mimeType);
  }
  return URL.createObjectURL(new Blob([toBlobPart(data)], { type: mimeType }));
}

/**
 * Release an object URL produced by `uint8ArrayToImageUrl`. Anything that is
 * not a `blob:` URL (data URLs, asset URLs, `null`) is ignored.
 */
export function releaseImageUrl(url: string | null | undefined): void {
  if (!url || !url.startsWith("blob:")) return;
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") {
    return;
  }
  URL.revokeObjectURL(url);
}
