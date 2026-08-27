/**
 * User-message segment parsing.
 *
 * Pure text layer behind UserMessageContent: turns the serialized
 * `displayName [type:path]` pill grammar produced by
 * ComposerInput.getTextWithPills() — plus Markdown references written by
 * external clients — into renderable segments. No React, no DOM.
 */
import { parseGitHubPillUrl } from "@src/components/ComposerInput/githubUrl";
import { parseHttpUrlPill } from "@src/components/ComposerInput/httpUrl";
import { serializePillNode } from "@src/components/ComposerInput/utils";
import { PILL_TYPES, PILL_TYPE_LIST } from "@src/config/pillTokens";
import type { PillType } from "@src/config/pillTokens";
import { normalizeUserMessageText } from "@src/engines/ChatPanel/ChatItems/normalizeUserMessageText";

/**
 * Local variant of PILL_REGEX that restricts the display-name capture group
 * to a single line (`[^\n[]` instead of `[^[]`). This prevents the whole
 * conversation text above a pill from being swallowed as the pill's label
 * when there are newlines between the preceding text and the `[type:path]`
 * token.
 */
const SINGLE_LINE_PILL_REGEX = new RegExp(
  `([^\\n[]+?)\\s*\\[(${PILL_TYPE_LIST.join("|")}):([^\\]]+)\\]`,
  "g"
);

// ============================================
// Types
// ============================================

export interface PillSegment {
  kind: "pill";
  displayName: string;
  pillType: PillType;
  path: string;
  /** Decoded terminal content embedded in the serialized pill (base64) */
  terminalText?: string;
}

export interface TextSegment {
  kind: "text";
  text: string;
}

export interface MentionSegment {
  kind: "mention";
  userId: string;
  displayName: string;
}

export type Segment = PillSegment | TextSegment | MentionSegment;

export interface UserMessageMention {
  userId: string;
  displayName: string;
}

function isMentionBoundary(char: string | undefined): boolean {
  return char === undefined || !/[\p{L}\p{N}_]/u.test(char);
}

/**
 * Split `@Display Name` occurrences out of text segments as mention pills.
 * Member pills serialize to plain `@name` (see serializePillNode), so the
 * names are matched back against the message's known mentions — longest
 * label first, case-insensitively, on word boundaries.
 */
export function splitMentionSegments(
  segments: readonly Segment[],
  mentions: readonly UserMessageMention[]
): Segment[] {
  const labelled = mentions
    .map((mention) => ({ mention, label: mention.displayName.trim() }))
    .filter((entry) => entry.label.length > 0)
    .sort((left, right) => right.label.length - left.label.length);
  if (labelled.length === 0) return [...segments];
  const result: Segment[] = [];
  for (const segment of segments) {
    if (segment.kind !== "text" || !segment.text.includes("@")) {
      result.push(segment);
      continue;
    }
    const text = segment.text;
    const lower = text.toLowerCase();
    let cursor = 0;
    let index = text.indexOf("@");
    while (index !== -1) {
      let consumed = 0;
      if (isMentionBoundary(text[index - 1])) {
        for (const entry of labelled) {
          const lowerLabel = entry.label.toLowerCase();
          if (
            lower.startsWith(lowerLabel, index + 1) &&
            isMentionBoundary(text[index + 1 + lowerLabel.length])
          ) {
            if (index > cursor) {
              result.push({ kind: "text", text: text.slice(cursor, index) });
            }
            result.push({
              kind: "mention",
              userId: entry.mention.userId,
              displayName: entry.label,
            });
            consumed = 1 + lowerLabel.length;
            cursor = index + consumed;
            break;
          }
        }
      }
      index = text.indexOf("@", index + Math.max(consumed, 1));
    }
    if (cursor < text.length) {
      result.push({ kind: "text", text: text.slice(cursor) });
    }
  }
  return result;
}

// ============================================
// Parser
// ============================================

/**
 * External clients commonly persist references as Markdown links instead of
 * ORGII's serialized pill tokens. Normalize safe web links, local file links,
 * and recognized native reference schemes while leaving images and escaped
 * Markdown untouched.
 */
const MARKDOWN_REFERENCE_REGEX = /\[([^\]\r\n]+)\]\(([^)\r\n]+)\)/g;

const NATIVE_SCHEME_PILL_TYPES: Readonly<Record<string, PillType>> = {
  "branch://": "branch",
  "browser://": "browser",
  "dom-element://": "dom-element",
  "folder://": "folder",
  "issue://": "issue",
  "paste://": "paste",
  "pr://": "pr",
  "project://": "project",
  "repo://": "repo",
  "session://": "session",
  "skill://": "skill",
  "terminal://": "terminal",
  "workitem://": "workitem",
};

function decodePath(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function filePathFromMarkdownDestination(destination: string): string | null {
  if (destination.startsWith("file://")) {
    try {
      const parsed = new URL(destination);
      if (parsed.protocol !== "file:") return null;
      const decodedPath = decodePath(parsed.pathname);
      if (!decodedPath) return null;

      if (parsed.hostname && parsed.hostname !== "localhost") {
        return `//${parsed.hostname}${decodedPath}`;
      }
      return /^\/[a-z]:\//i.test(decodedPath)
        ? decodedPath.slice(1)
        : decodedPath;
    } catch {
      return null;
    }
  }

  if (
    destination.startsWith("/") ||
    destination.startsWith("./") ||
    destination.startsWith("../") ||
    /^[a-z]:[\\/]/i.test(destination) ||
    destination.startsWith("\\\\")
  ) {
    return decodePath(destination);
  }

  return null;
}

function nativeSchemePillType(destination: string): PillType | null {
  for (const [prefix, pillType] of Object.entries(NATIVE_SCHEME_PILL_TYPES)) {
    if (destination.startsWith(prefix)) return pillType;
  }
  return null;
}

export function normalizeMarkdownReferencePills(text: string): string {
  return text.replace(
    MARKDOWN_REFERENCE_REGEX,
    (match, rawLabel: string, rawDestination: string, offset: number) => {
      if (
        offset > 0 &&
        (text[offset - 1] === "!" || text[offset - 1] === "\\")
      ) {
        return match;
      }

      const label = rawLabel.trim();
      const destination = rawDestination.trim().replace(/^<|>$/g, "");

      const githubReference = parseGitHubPillUrl(destination);
      if (githubReference) {
        return serializePillNode({
          filePath: githubReference.url,
          fileName: githubReference.displayName,
          iconType: githubReference.iconType,
        });
      }

      const httpReference = parseHttpUrlPill(destination);
      if (httpReference) {
        return serializePillNode({
          filePath: httpReference.url,
          fileName: httpReference.displayName,
          iconType: "link",
        });
      }

      const filePath = filePathFromMarkdownDestination(destination);
      if (filePath) {
        const isFolder = filePath.endsWith("/") || filePath.endsWith("\\");
        return serializePillNode({
          filePath,
          fileName: label,
          iconType: isFolder ? "folder" : "file",
        });
      }

      const pillType = nativeSchemePillType(destination);
      if (pillType) {
        return serializePillNode({
          filePath: destination,
          fileName: label,
          iconType: pillType,
        });
      }

      return match;
    }
  );
}

/** Backward-compatible name for the first URL-only normalization pass. */
export const normalizeMarkdownUrlPills = normalizeMarkdownReferencePills;

/**
 * Extract the first fenced code block from text.
 * Returns the content between ``` markers, or undefined if none found.
 */
function extractCodeBlock(text: string): string | undefined {
  const match = text.match(/```\n?([\s\S]*?)```/);
  return match?.[1]?.trim() || undefined;
}

export function parseNormalizedUserMessage(normalizedText: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;

  // Pre-extract code block for terminal pills that lack embedded content
  const codeBlockContent = extractCodeBlock(normalizedText);

  for (const match of normalizedText.matchAll(SINGLE_LINE_PILL_REGEX)) {
    const matchStart = match.index;
    if (matchStart === undefined) continue;

    // The regex captures everything on the same line before the bracket as
    // the display name. Split off any preceding text (before the last
    // whitespace-delimited token) so it renders as a plain text segment
    // rather than being absorbed into the pill label.
    const rawDisplayName = match[1];
    const lastSpaceIdx = rawDisplayName.search(/\s[^\s]*$/);
    let precedingText: string;
    let displayName: string;
    if (lastSpaceIdx >= 0) {
      precedingText = rawDisplayName.slice(0, lastSpaceIdx + 1);
      displayName = rawDisplayName.slice(lastSpaceIdx + 1).trim();
    } else {
      precedingText = "";
      displayName = rawDisplayName.trim();
    }

    // Text before this match
    if (matchStart > lastIndex) {
      segments.push({
        kind: "text",
        text: normalizedText.slice(lastIndex, matchStart),
      });
    }
    // Text on the same line that precedes the pill filename
    if (precedingText) {
      segments.push({ kind: "text", text: precedingText });
    }

    const pillType = match[2] as PillType;
    const rawPath = match[3];

    if (PILL_TYPES.has(pillType)) {
      // Context pills (terminal, browser) may embed base64 content
      // after "::" or have a code block fallback in the same message.
      // Session pills carry only the session ID — no embedded content.
      const isContextPill =
        pillType === "terminal" ||
        pillType === "browser" ||
        pillType === "dom-element" ||
        pillType === "dom-component" ||
        pillType === "paste" ||
        pillType === "pr" ||
        pillType === "issue";
      let path = rawPath;
      let terminalText: string | undefined;
      if (isContextPill) {
        if (rawPath.includes("::")) {
          const sepIdx = rawPath.indexOf("::");
          path = rawPath.slice(0, sepIdx);
          const encoded = rawPath.slice(sepIdx + 2);
          try {
            terminalText = decodeURIComponent(atob(encoded));
          } catch {
            // Malformed base64 — ignore
          }
        }
        if (pillType === "terminal" && !terminalText && codeBlockContent) {
          terminalText = codeBlockContent;
        }
      }
      segments.push({
        kind: "pill",
        displayName,
        pillType,
        path,
        terminalText,
      });
    } else {
      // Unknown type — keep as text
      segments.push({ kind: "text", text: match[0] });
    }

    lastIndex = matchStart + match[0].length;
  }

  // Check if any context pill (terminal/browser) consumed the code block
  const hasContextPill = segments.some(
    (s) =>
      s.kind === "pill" &&
      (s.pillType === "terminal" ||
        s.pillType === "browser" ||
        s.pillType === "dom-component" ||
        s.pillType === "paste" ||
        s.pillType === "pr" ||
        s.pillType === "issue")
  );

  // Strip trailing code blocks — they carry embedded context, not user text
  if (lastIndex < normalizedText.length) {
    let remaining = normalizedText.slice(lastIndex);
    if (hasContextPill && codeBlockContent) {
      remaining = remaining.replace(/\n*```\n?[\s\S]*?```\s*$/, "");
    }
    if (remaining) {
      segments.push({ kind: "text", text: remaining });
    }
  }

  return segments;
}

export function parseUserMessage(text: string): Segment[] {
  return parseNormalizedUserMessage(
    normalizeMarkdownReferencePills(normalizeUserMessageText(text))
  );
}

/**
 * Extract the bare session id from a serialized session pill path.
 * Current serialization stores the bare id (`[session:sdeagent-…]`);
 * legacy messages may carry `session://<id>/<ts>` (optionally with an
 * inline `::base64` suffix).
 */
export function sessionIdFromPillPath(path: string): string {
  const withoutScheme = path.startsWith("session://")
    ? path.slice("session://".length)
    : path;
  return withoutScheme.split("::")[0].split("/")[0];
}
