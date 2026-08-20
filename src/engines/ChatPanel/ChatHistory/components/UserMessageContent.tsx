/**
 * UserMessageContent
 *
 * Renders user message text with inline file/repo/branch pills.
 * Parses the serialized pill format: `displayName [type:path]`
 * produced by ComposerInput.getTextWithPills().
 */
import { useAtomValue } from "jotai";
import {
  Code,
  Folder,
  FolderKanban,
  GitBranch,
  GitPullRequest,
  Globe,
  Link,
  ListChecks,
  MousePointer2,
  SquareMousePointer,
  Terminal,
  Toolbox,
} from "lucide-react";
import React, { memo, useCallback, useMemo } from "react";

import GitHubPillIcon from "@src/assets/modelIcons/github-pill.svg";
import { ChatImageThumbnailRow } from "@src/components/ChatImageThumbnail";
import BasePill from "@src/components/ComposerInput/BasePill";
import CanvasCommandPillIcon, {
  isCanvasCommandPillPath,
} from "@src/components/ComposerInput/CanvasCommandPillIcon";
import {
  isGitHubPillUrl,
  parseGitHubPillUrl,
} from "@src/components/ComposerInput/githubUrl";
import { parseHttpUrlPill } from "@src/components/ComposerInput/httpUrl";
import {
  serializePillNode,
  truncateVisiblePillLabel,
} from "@src/components/ComposerInput/utils";
import FileTypeIcon from "@src/components/FileTypeIcon";
import {
  PILL_LINE_HEIGHT,
  PILL_SIZE,
  PILL_TYPES,
  PILL_TYPE_LIST,
} from "@src/config/pillTokens";
import type { PillType } from "@src/config/pillTokens";
import { normalizeUserMessageText } from "@src/engines/ChatPanel/ChatItems/normalizeUserMessageText";
import CanvasDomComponentPreview from "@src/features/DomSelection/CanvasDomComponentPreview";
import { parseCanvasDomComponent } from "@src/features/DomSelection/domComponentPayload";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { openExternalLink } from "@src/util/platform/ipcRenderer";
import { resolveSessionRowIcon } from "@src/util/session/sessionSidebarRow";

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

interface PillSegment {
  kind: "pill";
  displayName: string;
  pillType: PillType;
  path: string;
  /** Decoded terminal content embedded in the serialized pill (base64) */
  terminalText?: string;
}

interface TextSegment {
  kind: "text";
  text: string;
}

type Segment = PillSegment | TextSegment;

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

function parseNormalizedUserMessage(normalizedText: string): Segment[] {
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

// ============================================
// Pill Icon
// ============================================

const ICON_PROPS = { size: PILL_SIZE.iconSize, strokeWidth: 1.75 } as const;

const PillIcon: React.FC<{
  pillType: PillType;
  displayName: string;
  path: string;
}> = memo(function PillIcon({ pillType, displayName, path }) {
  if (isGitHubPillUrl(path)) {
    return (
      <GitHubPillIcon
        width={PILL_SIZE.iconSize}
        height={PILL_SIZE.iconSize}
        className="text-primary-6"
      />
    );
  }

  switch (pillType) {
    case "repo":
      return <Code {...ICON_PROPS} />;
    case "folder":
      return <Folder {...ICON_PROPS} />;
    case "branch":
      return <GitBranch {...ICON_PROPS} />;
    case "terminal":
      return <Terminal {...ICON_PROPS} />;
    case "session":
      return <SessionPillIcon path={path} />;
    case "browser":
      return <Globe {...ICON_PROPS} />;
    case "link":
      return <Link {...ICON_PROPS} />;
    case "dom-element":
      return <SquareMousePointer {...ICON_PROPS} />;
    case "dom-component":
      return <MousePointer2 {...ICON_PROPS} />;
    case "project":
      return <FolderKanban {...ICON_PROPS} />;
    case "workitem":
    case "issue":
      return <ListChecks {...ICON_PROPS} />;
    case "skill":
      if (isCanvasCommandPillPath(path)) {
        return <CanvasCommandPillIcon />;
      }
      return <Toolbox {...ICON_PROPS} />;
    case "pr":
      return <GitPullRequest {...ICON_PROPS} />;
    default:
      return <FileTypeIcon fileName={displayName} size="small" />;
  }
});
PillIcon.displayName = "PillIcon";

// ============================================
// Inline Pill (read-only, clickable)
// ============================================

/**
 * Extract the bare session id from a serialized session pill path.
 * Current serialization stores the bare id (`[session:sdeagent-…]`);
 * legacy messages may carry `session://<id>/<ts>` (optionally with an
 * inline `::base64` suffix).
 */
function sessionIdFromPillPath(path: string): string {
  const withoutScheme = path.startsWith("session://")
    ? path.slice("session://".length)
    : path;
  return withoutScheme.split("::")[0].split("/")[0];
}

const SessionPillIcon: React.FC<{ path: string }> = memo(({ path }) => {
  const sessionId = sessionIdFromPillPath(path);
  const session = useAtomValue(sessionByIdAtom(sessionId));
  const Icon = useMemo(
    () => resolveSessionRowIcon(session ?? sessionId),
    [session, sessionId]
  );
  return React.createElement(Icon, ICON_PROPS);
});
SessionPillIcon.displayName = "SessionPillIcon";

/**
 * Session pill labels resolve the LIVE session name from the store instead
 * of trusting the serialized token: the `displayName [type:path]` grammar
 * is single-token only, so multi-word session titles cannot round-trip
 * through it (they used to render as the last token, e.g. "啊p…").
 */
const SessionPillLabel: React.FC<{ path: string; fallback: string }> = memo(
  ({ path, fallback }) => {
    const session = useAtomValue(sessionByIdAtom(sessionIdFromPillPath(path)));
    const label = session?.name?.trim() || fallback;
    return <span>{truncateVisiblePillLabel(label)}</span>;
  }
);
SessionPillLabel.displayName = "SessionPillLabel";

const InlinePill: React.FC<{ segment: PillSegment }> = memo(({ segment }) => {
  const isGitHubUrl = isGitHubPillUrl(segment.path);
  const isGenericLink = segment.pillType === "link";
  const isClickable =
    isGitHubUrl ||
    isGenericLink ||
    segment.pillType === "terminal" ||
    segment.pillType === "file" ||
    segment.pillType === "folder" ||
    segment.pillType === "dom-component" ||
    segment.pillType === "paste";

  const handleClick = useCallback(
    (e: React.SyntheticEvent) => {
      e.stopPropagation();
      e.preventDefault();

      if (isGitHubUrl || isGenericLink) {
        void openExternalLink(segment.path);
        return;
      }

      if (segment.pillType === "terminal") {
        let sessionId: string;
        if (segment.path.startsWith("terminal://")) {
          const parts = segment.path.replace("terminal://", "").split("/");
          sessionId = parts[0];
        } else {
          sessionId = segment.path;
        }

        const terminalText =
          segment.terminalText ??
          window.__orgiiTerminalPillTexts?.[segment.path] ??
          undefined;

        document.dispatchEvent(
          new CustomEvent("terminal-pill-click", {
            detail: {
              sessionId,
              fileName: segment.displayName,
              terminalText,
            },
          })
        );
        return;
      }

      if (
        segment.pillType === "paste" ||
        segment.pillType === "dom-component"
      ) {
        // Route to the dedicated DomComponentPreview tab (Raw / Preview viewer).
        const pasteText =
          segment.terminalText ??
          window.__orgiiTerminalPillTexts?.[segment.path] ??
          "";
        document.dispatchEvent(
          new CustomEvent("dom-component-preview-click", {
            detail: {
              pasteId: segment.path,
              fileName: segment.displayName,
              jsonText: pasteText,
            },
          })
        );
        return;
      }

      if (segment.pillType === "file" || segment.pillType === "folder") {
        document.dispatchEvent(
          new CustomEvent("file-pill-click", {
            detail: {
              filePath: segment.path,
              fileName: segment.displayName,
              isFolder: segment.pillType === "folder",
            },
          })
        );
      }
    },
    [isGenericLink, isGitHubUrl, segment]
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!isClickable || (event.key !== "Enter" && event.key !== " ")) return;
      handleClick(event);
    },
    [handleClick, isClickable]
  );

  /** Prevent mousedown from triggering text-selection or parent click */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (isClickable) {
        e.stopPropagation();
        e.preventDefault();
      }
    },
    [isClickable]
  );

  const visibleDisplayName = useMemo(
    () =>
      isGitHubUrl || isGenericLink
        ? segment.displayName
        : truncateVisiblePillLabel(segment.displayName),
    [isGenericLink, isGitHubUrl, segment.displayName]
  );

  return (
    <BasePill
      variant="editor"
      className={
        isClickable
          ? "underline-offset-2 hover:underline focus-visible:underline active:underline"
          : undefined
      }
      iconNode={
        <PillIcon
          pillType={segment.pillType}
          displayName={segment.displayName}
          path={segment.path}
        />
      }
      role={isClickable ? "button" : undefined}
      tabIndex={isClickable ? 0 : undefined}
      style={{
        cursor: isClickable ? "var(--interactive-cursor, default)" : "default",
        position: "relative",
        zIndex: 1,
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      onClick={isClickable ? handleClick : undefined}
      onKeyDown={isClickable ? handleKeyDown : undefined}
      onMouseDown={handleMouseDown}
      title={segment.displayName}
    >
      {segment.pillType === "session" ? (
        <SessionPillLabel path={segment.path} fallback={segment.displayName} />
      ) : (
        <span>{visibleDisplayName}</span>
      )}
    </BasePill>
  );
});
InlinePill.displayName = "InlinePill";

// ============================================
// Main Component
// ============================================

interface UserMessageContentProps {
  text: string;
  /** Optional image URLs (data URLs or Tauri asset URLs) attached to this message */
  images?: string[];
}

const TEXT_BASE_CLASS =
  "whitespace-pre-wrap break-words text-[14px] leading-relaxed text-text-1";

const UserMessageContent: React.FC<UserMessageContentProps> = memo(
  ({ text, images }) => {
    const normalizedText = useMemo(
      () =>
        normalizeMarkdownReferencePills(normalizeUserMessageText(text, images)),
      [images, text]
    );
    const segments = useMemo(
      () => parseNormalizedUserMessage(normalizedText),
      [normalizedText]
    );
    const hasImages = images && images.length > 0;
    const canvasSelectionJson = segments.find(
      (segment): segment is PillSegment =>
        segment.kind === "pill" &&
        segment.pillType === "dom-component" &&
        parseCanvasDomComponent(segment.terminalText) !== null
    )?.terminalText;

    // Fast path: no pills and no images, render plain text
    const hasPills = segments.some((s) => s.kind === "pill");
    if (!hasPills && !hasImages) {
      return <span className={TEXT_BASE_CLASS}>{normalizedText}</span>;
    }

    return (
      <div className="flex flex-col gap-2">
        {hasImages && <ChatImageThumbnailRow images={images} />}
        {canvasSelectionJson && (
          <CanvasDomComponentPreview jsonText={canvasSelectionJson} />
        )}
        {normalizedText && normalizedText !== "(image)" && (
          <span
            className="whitespace-pre-wrap break-words text-[14px] text-text-1"
            style={{ lineHeight: PILL_LINE_HEIGHT }}
          >
            {segments.map((segment, idx) =>
              segment.kind === "text" ? (
                <React.Fragment key={idx}>{segment.text}</React.Fragment>
              ) : (
                <InlinePill key={idx} segment={segment} />
              )
            )}
          </span>
        )}
      </div>
    );
  }
);
UserMessageContent.displayName = "UserMessageContent";

export default UserMessageContent;
