import { isWindows } from "@src/util/platform/tauri";

import { getFileName } from "./pathUtils";

export interface RepoPathDisplayInput {
  path?: string;
  repoPath?: string;
  cwd?: string;
  rootLabel?: string;
}

export interface RepoPathDisplayParts {
  normalizedPath: string;
  normalizedRoot?: string;
  rootLabel?: string;
  relativePath?: string;
  displayPath: string;
  title: string;
}

export type RepoPathArgs = Record<string, unknown> | undefined;

export interface ToolTargetPathInput {
  args?: RepoPathArgs;
  repoPath?: string;
  pathKeys: string[];
}

const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:\//;

export function normalizeDisplayPath(path: string | undefined): string {
  return (path ?? "").trim().replace(/\\/g, "/").replace(/\/+/g, "/");
}

export function getPlatformPathSeparator(): "/" | "\\" {
  return isWindows() ? "\\" : "/";
}

export function formatPathForPlatformDisplay(
  path: string | undefined,
  separator: "/" | "\\" = getPlatformPathSeparator()
): string {
  if (!path) return "";
  if (separator === "/") return path;
  return path.replace(/\//g, "\\");
}

function nestedArgs(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function argSources(args: RepoPathArgs): Record<string, unknown>[] {
  if (!args || typeof args !== "object") return [];
  return [
    args,
    nestedArgs(args.input),
    nestedArgs(args.params),
    nestedArgs(args.arguments),
    nestedArgs(args.tool_input),
    nestedArgs(args.toolInput),
  ].filter((source): source is Record<string, unknown> => Boolean(source));
}

export function pickToolArgString(
  args: RepoPathArgs,
  ...keys: string[]
): string | undefined {
  for (const source of argSources(args)) {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value.trim();
      }
    }
  }
  return undefined;
}

export function resolveToolTargetPath({
  args,
  repoPath,
  pathKeys,
}: ToolTargetPathInput): string | undefined {
  return (
    pickToolArgString(args, "repo_path", "repoPath") ||
    pickToolArgString(args, ...pathKeys) ||
    repoPath ||
    undefined
  );
}

export function formatToolTargetPath(
  input: ToolTargetPathInput
): string | undefined {
  const explicitRepoPath = pickToolArgString(
    input.args,
    "repo_path",
    "repoPath"
  );
  const targetPath =
    explicitRepoPath ||
    pickToolArgString(input.args, ...input.pathKeys) ||
    input.repoPath ||
    undefined;
  const rootPath = explicitRepoPath || input.repoPath;
  return targetPath
    ? formatRepoPathForDisplay({ path: targetPath, repoPath: rootPath })
        .displayPath
    : undefined;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || WINDOWS_ABSOLUTE_RE.test(path);
}

function stripTrailingSlash(path: string): string {
  if (path === "/") return path;
  return path.replace(/\/+$/, "");
}

function pathInsideRoot(path: string, root: string): boolean {
  const normalizedRoot = stripTrailingSlash(root);
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

function defaultRootLabel(root: string): string {
  const parts = root.split("/").filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
  }
  return getFileName(root) || root;
}

function toTildePath(path: string): string {
  const home = normalizeDisplayPath(
    typeof process !== "undefined" ? process.env?.HOME : undefined
  );
  if (home && path.startsWith(`${stripTrailingSlash(home)}/`)) {
    return `~/${path.slice(stripTrailingSlash(home).length + 1)}`;
  }
  return path;
}

export function formatRepoPathForDisplay(
  input: RepoPathDisplayInput
): RepoPathDisplayParts {
  const normalizedPath = normalizeDisplayPath(input.path);
  const normalizedRepo = stripTrailingSlash(
    normalizeDisplayPath(input.repoPath)
  );
  const normalizedCwd = stripTrailingSlash(normalizeDisplayPath(input.cwd));
  const normalizedRoot = normalizedRepo || normalizedCwd || undefined;
  const rootLabel =
    input.rootLabel ||
    (normalizedRoot ? defaultRootLabel(normalizedRoot) : undefined);
  const separator = getPlatformPathSeparator();
  const toPlatformDisplay = (path: string) =>
    formatPathForPlatformDisplay(path, separator);

  if (!normalizedPath) {
    return {
      normalizedPath,
      normalizedRoot,
      rootLabel,
      displayPath: "",
      title: "",
    };
  }

  if (!isAbsolutePath(normalizedPath)) {
    const displayPath = rootLabel
      ? `${rootLabel}/${normalizedPath}`
      : normalizedPath;
    const title = normalizedRoot
      ? `${normalizedRoot}/${normalizedPath}`
      : normalizedPath;
    return {
      normalizedPath,
      normalizedRoot,
      rootLabel,
      relativePath: normalizedPath,
      displayPath: toPlatformDisplay(displayPath),
      title,
    };
  }

  if (normalizedRoot && pathInsideRoot(normalizedPath, normalizedRoot)) {
    const relativePath =
      normalizedPath === normalizedRoot
        ? ""
        : normalizedPath.slice(normalizedRoot.length + 1);
    const displayPath =
      relativePath && rootLabel
        ? `${rootLabel}/${relativePath}`
        : rootLabel || normalizedPath;
    return {
      normalizedPath,
      normalizedRoot,
      rootLabel,
      relativePath,
      displayPath: toPlatformDisplay(displayPath),
      title: toPlatformDisplay(normalizedPath),
    };
  }

  const displayPath = toTildePath(normalizedPath);
  return {
    normalizedPath,
    normalizedRoot,
    rootLabel,
    displayPath: toPlatformDisplay(displayPath),
    title: toPlatformDisplay(normalizedPath),
  };
}

export function compactRepoPathForDisplay(input: RepoPathDisplayInput): string {
  return formatRepoPathForDisplay(input).displayPath;
}
