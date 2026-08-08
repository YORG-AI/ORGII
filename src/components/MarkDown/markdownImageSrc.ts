/**
 * Classify a markdown image `src` for the chat renderer.
 *
 * The webview origin cannot load raw filesystem paths, but agents routinely
 * reference generated artifacts by absolute or repo-relative path. Local
 * classifications are read through the fs plugin into a data URL by
 * `MarkdownLocalImage`; web/data sources render as a plain `<img>`.
 */
import { imageRefToRustPath } from "@src/util/file/imageRefs";

const TAURI_ASSET_PREFIXES = [
  "asset://localhost",
  "https://asset.localhost",
  "http://asset.localhost",
] as const;

const SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;

export type MarkdownImageSource =
  | { kind: "remote"; src: string }
  | { kind: "local"; path: string; homeRelative?: boolean }
  | { kind: "skip" };

function decodeMaybeEncodedPath(path: string): string {
  if (!path.includes("%")) return path;
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function fileUrlToPath(src: string): string | null {
  try {
    const parsed = new URL(src);
    if (parsed.protocol !== "file:") return null;
    const decoded = decodeMaybeEncodedPath(parsed.pathname);
    if (parsed.hostname && parsed.hostname !== "localhost") {
      return `//${parsed.hostname}${decoded}`;
    }
    return /^\/[a-z]:\//i.test(decoded) ? decoded.slice(1) : decoded;
  } catch {
    return null;
  }
}

export function classifyMarkdownImageSrc(
  src: string | undefined,
  workspaceRootPath?: string | null
): MarkdownImageSource {
  const trimmed = src?.trim();
  if (!trimmed) return { kind: "skip" };

  if (trimmed.startsWith("data:")) return { kind: "remote", src: trimmed };

  for (const prefix of TAURI_ASSET_PREFIXES) {
    if (trimmed.startsWith(prefix)) {
      return { kind: "local", path: imageRefToRustPath(trimmed) };
    }
  }

  if (trimmed.startsWith("file://")) {
    const path = fileUrlToPath(trimmed);
    return path ? { kind: "local", path } : { kind: "skip" };
  }

  if (
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\\\") ||
    /^[a-z]:[\\/]/i.test(trimmed)
  ) {
    return { kind: "local", path: decodeMaybeEncodedPath(trimmed) };
  }

  if (SCHEME_REGEX.test(trimmed)) return { kind: "remote", src: trimmed };

  if (trimmed.startsWith("~/")) {
    return {
      kind: "local",
      path: decodeMaybeEncodedPath(trimmed.slice(2)),
      homeRelative: true,
    };
  }

  const root = workspaceRootPath?.trim();
  if (root) {
    const relative = decodeMaybeEncodedPath(trimmed.replace(/^\.\//, ""));
    const separator = root.includes("\\") ? "\\" : "/";
    const joined = root.endsWith(separator)
      ? `${root}${relative}`
      : `${root}${separator}${relative}`;
    return { kind: "local", path: joined };
  }

  return { kind: "skip" };
}
