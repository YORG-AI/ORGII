import { parseMarkdownFileRef } from "./markdownFileRef";
import {
  type MarkdownImageSource,
  classifyMarkdownImageSrc,
} from "./markdownImageSrc";

export type MarkdownLinkTarget =
  | Extract<MarkdownImageSource, { kind: "local" }>
  | { kind: "browser"; url: string };

const WELL_KNOWN_REPO_FILENAMES = new Set([
  "dockerfile",
  "gemfile",
  "license",
  "makefile",
  "notice",
  "procfile",
]);

const SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function decodeMaybeEncodedHref(href: string): string {
  if (!href.includes("%")) return href;
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

function resolveWorkspaceRelativeHref(href: string, workspaceRoot: string) {
  const separator = workspaceRoot.includes("\\") ? "\\" : "/";
  const normalizedRoot = workspaceRoot.trim().replace(/[\\/]+$/, "");
  const relativePath = decodeMaybeEncodedHref(href.trim())
    .replace(/^\.([\\/])/, "")
    .replace(/[\\/]/g, separator);
  return `${normalizedRoot}${separator}${relativePath}`;
}

export function isWorkspaceRelativeMarkdownFileHref(href: string): boolean {
  const trimmed = decodeMaybeEncodedHref(href.trim());
  if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("?")) {
    return false;
  }

  const fileRef = parseMarkdownFileRef(trimmed);
  const normalizedPath = fileRef.path.replace(/\\/g, "/");
  const segments = normalizedPath.split("/").filter(Boolean);
  if (segments.length === 0 || segments.includes("..")) return false;
  if (
    segments.length > 1 &&
    !segments[0].startsWith(".") &&
    /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(segments[0])
  ) {
    return false;
  }

  const basename = segments[segments.length - 1]?.toLowerCase() ?? "";
  const hasFileShapedBasename =
    WELL_KNOWN_REPO_FILENAMES.has(basename) ||
    /\.[a-z][a-z0-9.-]*$/i.test(basename);

  // A basename with a source line (for example `WebsiteCard.tsx:84`) looks
  // like a URI scheme to generic URL parsers. Admit that exact file shape,
  // but keep real and nested schemes such as `mailto:` or `vscode:` remote.
  if (
    SCHEME_PATTERN.test(trimmed) &&
    (fileRef.line === undefined ||
      fileRef.path.includes(":") ||
      !hasFileShapedBasename)
  ) {
    return false;
  }

  if (fileRef.line !== undefined) return true;
  if (normalizedPath.startsWith("./")) return true;

  return hasFileShapedBasename;
}

/**
 * Classify a rendered markdown href without turning every relative web route
 * into a workspace path. Agent-authored source references carry a line suffix
 * or a file-shaped basename, which gives us a narrow local-file signal.
 */
export function classifyMarkdownLinkTarget(
  href: string,
  workspaceRootPath?: string | null
): MarkdownLinkTarget {
  if (/^\/\/[^/]/.test(href.trim())) {
    return { kind: "browser", url: href };
  }

  const directSource = classifyMarkdownImageSrc(href);
  if (directSource.kind === "local") return directSource;

  const workspaceRoot = workspaceRootPath?.trim();
  if (workspaceRoot && isWorkspaceRelativeMarkdownFileHref(href)) {
    return {
      kind: "local",
      path: resolveWorkspaceRelativeHref(href, workspaceRoot),
    };
  }

  if (directSource.kind === "remote") {
    return { kind: "browser", url: directSource.src };
  }

  return { kind: "browser", url: href };
}
