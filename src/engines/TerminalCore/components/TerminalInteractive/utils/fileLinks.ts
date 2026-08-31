import type { ILink } from "@xterm/xterm";

import type { TerminalViewProps } from "../types";

const TERMINAL_FILE_LINK_PATTERN =
  /(?:(?:\.{1,2}|~|\/)[^\s"'`<>]+|[A-Za-z0-9_@][\w@.-]*(?:\/[\w@.()[\]-]+)+)(?::(\d+))?(?::\d+)?/g;

const TRAILING_FILE_LINK_CHARS = /[),.;\]]+$/;

function trimTerminalFileLink(text: string): string {
  return text.replace(TRAILING_FILE_LINK_CHARS, "");
}

function isLikelyFilePath(path: string): boolean {
  if (!path.includes("/") && !path.startsWith("~")) return false;
  if (path.includes("://")) return false;
  return /\.[A-Za-z0-9]{1,12}$/.test(path.split("/").pop() ?? "");
}

export function resolveTerminalFilePath(
  rawPath: string,
  workingDirectory?: string,
  repoPath?: string
): string {
  if (rawPath.startsWith("/")) return rawPath;
  if (rawPath.startsWith("~/")) return rawPath;

  if (rawPath.startsWith("./")) {
    const basePath = workingDirectory || repoPath;
    return basePath ? `${basePath}/${rawPath.slice(2)}` : rawPath.slice(2);
  }

  if (rawPath.startsWith("../")) {
    const basePath = workingDirectory || repoPath;
    return basePath ? `${basePath}/${rawPath}` : rawPath;
  }

  const basePath = repoPath || workingDirectory;
  return basePath ? `${basePath}/${rawPath}` : rawPath;
}

export function createTerminalFileLinks(
  text: string,
  bufferLineNumber: number,
  options: {
    repoPath?: string;
    workingDirectory?: string;
    onOpenFileLink: NonNullable<TerminalViewProps["onOpenFileLink"]>;
  }
): ILink[] {
  const links: ILink[] = [];
  TERMINAL_FILE_LINK_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(TERMINAL_FILE_LINK_PATTERN)) {
    const matchedText = match[0];
    const trimmedText = trimTerminalFileLink(matchedText);
    const lineSuffix = trimmedText.match(/:(\d+)(?::\d+)?$/);
    const path = lineSuffix
      ? trimmedText.slice(0, lineSuffix.index)
      : trimmedText;

    if (!isLikelyFilePath(path)) continue;

    const startIndex = match.index ?? 0;
    const linkLength = trimmedText.length;
    const line = lineSuffix ? Number(lineSuffix[1]) : undefined;
    const startColumn = startIndex + 1;
    const endColumn = startIndex + linkLength;

    links.push({
      text: trimmedText,
      range: {
        start: { x: startColumn, y: bufferLineNumber },
        end: { x: endColumn, y: bufferLineNumber },
      },
      activate: (event, linkText) => {
        if (!event.metaKey && !event.ctrlKey) return;
        const resolvedPath = resolveTerminalFilePath(
          lineSuffix ? linkText.slice(0, lineSuffix.index) : path,
          options.workingDirectory,
          options.repoPath
        );
        options.onOpenFileLink({ path: resolvedPath, line });
      },
    });
  }

  return links;
}
