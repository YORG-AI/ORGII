import { homeDir } from "@tauri-apps/api/path";

import { parseGitArtifactsFromText } from "@src/shared/git/sessionGitArtifacts";
import { createSessionIdTextPattern } from "@src/util/session/sessionDispatch";
import { normalizeHttpUrlCandidate } from "@src/util/url/validation";

const WEB_URL_PATTERN = /https?:\/\/[^\s<>"'`\])}]+/gi;
const TRAILING_REFERENCE_PUNCTUATION_PATTERN = /[.,;:!?]+$/;
const MAX_REFERENCE_CARDS = 4;

export type MessageReferenceKind =
  | "web_url"
  | "local_path"
  | "git_commit"
  | "session";

export interface MessageReferenceItem {
  kind: MessageReferenceKind;
  value: string;
  title: string;
  subtitle: string;
  isDirectory?: boolean;
  url?: string;
  sha?: string;
  shortSha?: string;
  authorName?: string;
  authorDate?: string;
  sessionId?: string;
}

function stripFencedCodeBlocks(content: string): string {
  const lines = content.split("\n");
  let insideFence = false;
  return lines
    .map((line) => {
      if (line.trimStart().startsWith("```")) {
        insideFence = !insideFence;
        return "";
      }
      return insideFence ? "" : line;
    })
    .join("\n");
}

function normalizeUrlCandidate(candidate: string): string | null {
  return normalizeHttpUrlCandidate(
    candidate.replace(TRAILING_REFERENCE_PUNCTUATION_PATTERN, "")
  );
}

function isUrlCitedInParentheses(
  content: string,
  matchIndex: number,
  matchLength: number
): boolean {
  const before = content[matchIndex - 1];
  const twoCharsBefore = content.slice(Math.max(0, matchIndex - 2), matchIndex);
  const after = content[matchIndex + matchLength];
  return before === "(" && twoCharsBefore !== "](" && after === ")";
}

function getUrlHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isGitHubCommitUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "github.com" &&
      /\/[^/]+\/[^/]+\/commit\/[0-9a-f]{7,40}$/i.test(parsed.pathname)
    );
  } catch {
    return false;
  }
}

function makeCommitReferenceItem(artifact: {
  sha?: string;
  shortSha?: string;
  subject?: string;
  repoFullName?: string;
  url?: string;
}): MessageReferenceItem | null {
  const sha = artifact.sha?.trim().toLowerCase();
  const shortSha = artifact.shortSha ?? sha?.slice(0, 7);
  if (!sha && !shortSha) return null;
  const label = shortSha ?? sha ?? "";
  return {
    kind: "git_commit",
    value: sha ?? label,
    title: artifact.subject || `Commit ${label}`,
    subtitle: artifact.repoFullName
      ? `${label} · ${artifact.repoFullName}`
      : label,
    url: artifact.url,
    sha,
    shortSha: label,
  };
}

export function makeReferenceKey(item: MessageReferenceItem): string {
  if (item.kind === "git_commit") {
    return `git_commit:${item.sha ?? item.shortSha ?? item.value}`;
  }
  return `${item.kind}:${item.value}`;
}

function shortSessionIdLabel(sessionId: string): string {
  const uuidStart = sessionId.search(
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
  );
  if (uuidStart <= 0) return sessionId;
  return `${sessionId.slice(0, uuidStart)}${sessionId.slice(uuidStart, uuidStart + 8)}…`;
}

const SESSION_PILL_REFERENCE_PATTERN = /([^\n[]+?)\s*\[session:([^\]]+)\]/g;

function lastTokenLabel(rawLabel: string): string {
  const trimmed = rawLabel.trim();
  const lastSpaceIdx = trimmed.search(/\s[^\s]*$/);
  return lastSpaceIdx >= 0 ? trimmed.slice(lastSpaceIdx + 1).trim() : trimmed;
}

function makeSessionReferenceItem(
  sessionId: string,
  title?: string
): MessageReferenceItem {
  return {
    kind: "session",
    value: sessionId,
    title: title?.trim() || shortSessionIdLabel(sessionId),
    subtitle: sessionId,
    sessionId,
  };
}

function addReference(
  item: MessageReferenceItem,
  references: MessageReferenceItem[],
  seen: Set<string>
): boolean {
  const key = makeReferenceKey(item);
  if (seen.has(key)) return references.length >= MAX_REFERENCE_CARDS;
  seen.add(key);
  references.push(item);
  return references.length >= MAX_REFERENCE_CARDS;
}

export function extractMessageReferences(
  content: string,
  excludeUrls?: ReadonlySet<string>
): MessageReferenceItem[] {
  const searchableContent = stripFencedCodeBlocks(content);
  const references: MessageReferenceItem[] = [];
  const seen = new Set<string>();

  for (const match of searchableContent.matchAll(
    SESSION_PILL_REFERENCE_PATTERN
  )) {
    if (
      addReference(
        makeSessionReferenceItem(match[2], lastTokenLabel(match[1])),
        references,
        seen
      )
    )
      return references;
  }

  for (const match of searchableContent.matchAll(
    createSessionIdTextPattern()
  )) {
    if (addReference(makeSessionReferenceItem(match[0]), references, seen))
      return references;
  }

  for (const artifact of parseGitArtifactsFromText(searchableContent)) {
    if (artifact.kind !== "commit") continue;
    const item = makeCommitReferenceItem(artifact);
    if (!item) continue;
    const key = makeReferenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(item);
    if (references.length >= MAX_REFERENCE_CARDS) return references;
  }

  for (const match of searchableContent.matchAll(WEB_URL_PATTERN)) {
    const url = normalizeUrlCandidate(match[0]);
    if (!url) continue;
    if (isGitHubCommitUrl(url)) continue;
    if (excludeUrls?.has(url)) continue;
    if (
      isUrlCitedInParentheses(
        searchableContent,
        match.index ?? 0,
        match[0].length
      )
    )
      continue;
    const item: MessageReferenceItem = {
      kind: "web_url",
      value: url,
      title: getUrlHost(url),
      subtitle: url,
    };
    const key = makeReferenceKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    references.push(item);
    if (references.length >= MAX_REFERENCE_CARDS) return references;
  }

  return references;
}

export function collapseRelativePathSegments(path: string): string {
  if (
    !path ||
    (!path.includes("/./") &&
      !path.includes("/../") &&
      !path.endsWith("/.") &&
      !path.endsWith("/.."))
  ) {
    return path;
  }

  const isAbsolute = path.startsWith("/");
  const hasTrailingSlash = path.length > 1 && path.endsWith("/");
  const segments = path.split("/").filter((segment) => segment.length > 0);
  const stack: string[] = [];

  for (const segment of segments) {
    if (segment === ".") continue;
    if (segment === "..") {
      if (stack.length > 0 && stack[stack.length - 1] !== "..") {
        stack.pop();
      } else if (!isAbsolute) {
        stack.push("..");
      }
      continue;
    }
    stack.push(segment);
  }

  const joined = stack.join("/");
  if (isAbsolute) {
    const body = joined.length > 0 ? `/${joined}` : "/";
    return hasTrailingSlash && body !== "/" ? `${body}/` : body;
  }
  if (joined.length === 0) return ".";
  return hasTrailingSlash ? `${joined}/` : joined;
}

export async function resolveOpenPath(path: string): Promise<string> {
  if (!path.startsWith("~/")) return collapseRelativePathSegments(path);
  const home = await homeDir();
  const expanded = `${home.replace(/\/+$/, "")}/${path.slice(2)}`;
  return collapseRelativePathSegments(expanded);
}
