/**
 * Preview asset URLs
 *
 * Lets a preview hand WebKit a `src` it can stream straight from disk through
 * Tauri's asset protocol (which answers HTTP range requests), instead of the
 * frontend reading the whole file into a Blob. The Rust side widens the asset
 * scope for exactly the requested file, so only files the user opened become
 * URL-addressable, and the fs plugin could already read all of them.
 */
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

import { createLogger } from "@src/hooks/logger";

const log = createLogger("previewAssetUrl");

/**
 * Resolve an asset-protocol URL for `filePath`, or `null` when the file
 * cannot be served that way (browser mode, missing file, host without the
 * protocol). Callers fall back to the in-memory Blob path on `null`, so the
 * preview behaves exactly as before wherever the protocol is unavailable.
 */
export async function resolvePreviewAssetUrl(
  filePath: string
): Promise<string | null> {
  try {
    const canonicalPath = await invoke<string>("allow_preview_asset", {
      filePath,
    });
    return convertFileSrc(canonicalPath);
  } catch (error) {
    log.warn("Falling back to the in-memory preview", { filePath, error });
    return null;
  }
}

/**
 * Check that the asset handler actually serves `url` before giving it to an
 * element that cannot report a load failure (an `<iframe>`). One byte is
 * requested, so the probe is cheap even for very large files.
 */
export async function probePreviewAssetUrl(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { headers: { Range: "bytes=0-0" } });
    return response.ok;
  } catch (error) {
    log.warn("Asset probe failed, falling back to the in-memory preview", {
      url,
      error,
    });
    return false;
  }
}
