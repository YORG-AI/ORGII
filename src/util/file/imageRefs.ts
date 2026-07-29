const TAURI_ASSET_PREFIXES = [
  "asset://localhost",
  "https://asset.localhost",
  "http://asset.localhost",
] as const;

/**
 * Convert a Tauri asset URL back to the filesystem path used by Rust and the
 * filesystem plugin. Data URLs and plain paths are already usable as-is.
 */
export function imageRefToRustPath(ref: string): string {
  if (ref.startsWith("data:")) return ref;
  for (const prefix of TAURI_ASSET_PREFIXES) {
    if (ref.startsWith(prefix)) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(ref.slice(prefix.length));
      } catch {
        return ref;
      }
      return /^\/[a-z]:\//i.test(decoded) ? decoded.slice(1) : decoded;
    }
  }
  return ref;
}
