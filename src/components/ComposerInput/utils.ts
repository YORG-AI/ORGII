/**
 * ComposerInput utilities
 *
 * Pure helpers — text sanitization, pill serialization, DOM ↔ pill-attrs
 * round-tripping, and selection helpers. Kept dependency-free so the
 * main component file stays under the file-size limit.
 */
import { CONTEXT_PILL_PREFIXES, readPillText } from "@src/config/pillTokens";

import type { ComposerPillAttrs, PillIconType } from "./types";

export const PILL_DATA_ATTR = "data-composer-pill";
/**
 * Max age (ms) for cached terminal copy metadata. Mirrors the value
 * `ComposerInput/utils.ts` used so any in-flight `window.__orgiiLastTerminalCopy`
 * payload is interpreted with the same window.
 */
export const TERMINAL_COPY_MAX_AGE = 30_000;

/**
 * Strip characters that show up as "tofu" boxes on certain macOS keyboard
 * layouts and via remote-input layers (private-use codepoints, zero-width
 * marks, control chars). Identical to the policy `ComposerInput` used.
 */
export function sanitizeText(value: string): string {
  return (
    value
      .normalize("NFC")
      .replace(/[\uFFFD\uFFFE\uFFFF]/g, "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[\uF700-\uF8FF]/g, "")
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
  );
}

/**
 * Reject placeholder/index-style pill paths (e.g. `"1"`) that upstream
 * mention sources occasionally produce. We do not want these to serialize
 * as `[file:1]` and pollute the agent prompt.
 */
export function isInvalidFilePillPath(path: string): boolean {
  const trimmedPath = path.trim();
  if (!trimmedPath) return true;
  return /^\d+$/.test(trimmedPath);
}

/**
 * The pill grammar `displayName [type:path]` can only round-trip when the
 * display name is a single token: every parser (UserMessageContent,
 * pillContentParser) splits the label from preceding prose at the LAST
 * whitespace. Display names with spaces — session titles especially — used
 * to mangle into "last token only" labels after send. Collapse whitespace
 * runs to "-" and strip square brackets (which would break the bracket
 * grammar itself) so the serialized label is always one regex-safe token.
 */
export function sanitizePillDisplayLabel(name: string): string {
  return name.trim().replace(/[[\]]/g, "").replace(/\s+/g, "-");
}

const VISIBLE_PILL_LABEL_MAX_CHARS = 10;

export function truncateVisiblePillLabel(label: string): string {
  if (label.length <= VISIBLE_PILL_LABEL_MAX_CHARS) return label;

  const compoundExtensionMatch = label.match(/\.index\.[^.]+$/i);
  const lastDotIndex = label.lastIndexOf(".");
  const extension =
    compoundExtensionMatch?.[0] ??
    (lastDotIndex > 0 ? label.slice(lastDotIndex) : "");
  return `${label.slice(0, VISIBLE_PILL_LABEL_MAX_CHARS)}...${extension}`;
}

/**
 * Serialize a single pill to the agent-consumable text format. This is the
 * exact contract that `getTextWithPills()` exposes — every pill becomes
 * `<displayName> [<iconType>:<path>]` (with a few special cases for
 * repo/branch/folder/project/skill and base64-attached context pills).
 */
export function serializePillNode(
  attrs: Pick<ComposerPillAttrs, "filePath" | "fileName" | "iconType">
): string {
  const path = attrs.filePath ?? "";
  const rawDisplayName = attrs.fileName ?? path.split("/").pop() ?? path;
  const iconType = (attrs.iconType ?? "file") as PillIconType;

  const iconTypeStr = iconType as string;
  if (iconTypeStr === "member") return `@${rawDisplayName}`;

  const displayName =
    sanitizePillDisplayLabel(rawDisplayName) || rawDisplayName;
  if (iconTypeStr === "repo") return `${displayName} [repo:${path}]`;
  if (iconTypeStr === "branch") return `${displayName} [branch:${path}]`;
  if (iconTypeStr === "folder") return `${displayName} [folder:${path}]`;
  if (iconTypeStr === "project") return `${displayName} [project:${path}]`;
  if (iconTypeStr === "skill") return `${displayName} [skill:${path}]`;

  // Session pills pass only the session ID — no transcript embedding
  if (iconTypeStr === "session") {
    const sessionId = path.startsWith("session://")
      ? path.replace("session://", "").split("/")[0]
      : path;
    return `${displayName} [session:${sessionId}]`;
  }

  const contextPrefix = CONTEXT_PILL_PREFIXES[iconType as string];
  if (contextPrefix && path.startsWith(contextPrefix)) {
    const stored = readPillText(path);
    if (stored) {
      const encoded = btoa(encodeURIComponent(stored));
      return `${displayName} [${iconType}:${path}::${encoded}]`;
    }
    return `${displayName} [${iconType}:${path}]`;
  }

  if (isInvalidFilePillPath(path)) {
    return displayName;
  }
  return `${displayName} [file:${path}]`;
}

/**
 * Read attrs back from a pill DOM element. The component stores every field
 * as a `data-*` attribute so DOM-only inspections (drag/drop, clipboard,
 * `getFilePills()`) do not need an external map.
 */
export function readPillAttrs(element: HTMLElement): ComposerPillAttrs {
  const lineStartRaw = element.getAttribute("data-line-start");
  const lineEndRaw = element.getAttribute("data-line-end");
  return {
    filePath: element.getAttribute("data-file-path") ?? "",
    fileName: element.getAttribute("data-file-name") ?? "",
    isFolder: element.getAttribute("data-is-folder") === "true",
    iconType:
      (element.getAttribute("data-icon-type") as PillIconType | null) || null,
    lineStart: lineStartRaw ? parseInt(lineStartRaw, 10) : null,
    lineEnd: lineEndRaw ? parseInt(lineEndRaw, 10) : null,
  };
}

/**
 * Build the data attributes for a pill host span. Mirrors `readPillAttrs`.
 */
export function pillDataAttributes(
  attrs: ComposerPillAttrs
): Record<string, string> {
  const result: Record<string, string> = {
    [PILL_DATA_ATTR]: "true",
    "data-file-path": attrs.filePath,
    "data-file-name": attrs.fileName,
    "data-is-folder": String(attrs.isFolder),
  };
  if (attrs.iconType) result["data-icon-type"] = attrs.iconType;
  if (attrs.lineStart != null)
    result["data-line-start"] = String(attrs.lineStart);
  if (attrs.lineEnd != null) result["data-line-end"] = String(attrs.lineEnd);
  return result;
}

/**
 * Shared DOM walker for the editor contenteditable host. Handles text nodes,
 * block boundaries (`<br>`, `<div>`, `<p>`), and pill nodes. When a pill is
 * encountered, `onPill` is called and its return value is appended instead of
 * the raw display name.
 */
function walkEditorDom(
  root: HTMLElement,
  onPill: (element: HTMLElement) => string
): string {
  const parts: string[] = [];
  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;

    if (element.getAttribute(PILL_DATA_ATTR) === "true") {
      parts.push(onPill(element));
      return;
    }

    const tag = element.tagName;
    if (tag === "BR") {
      parts.push("\n");
      return;
    }

    const isBlock = tag === "DIV" || tag === "P";
    if (
      isBlock &&
      parts.length > 0 &&
      !parts[parts.length - 1].endsWith("\n")
    ) {
      parts.push("\n");
    }
    element.childNodes.forEach(visit);
  };
  root.childNodes.forEach(visit);
  return parts.join("").replace(/\u200B/g, "");
}

/**
 * Walk the editor root and produce the plain text representation. Pills
 * render as their display name; explicit `<br>` and block boundaries become
 * `\n`. This is what `getText()` returns and what the slash-command /
 * mention update path inspects.
 */
export function extractPlainText(root: HTMLElement): string {
  return walkEditorDom(
    root,
    (element) => element.getAttribute("data-file-name") ?? ""
  );
}

/**
 * Like `extractPlainText`, but pills are emitted via `serializePillNode`.
 */
export function extractTextWithPills(root: HTMLElement): string {
  return walkEditorDom(root, (element) =>
    serializePillNode(readPillAttrs(element))
  );
}

export function extractSerializedTextFromRange(range: Range): string {
  const fragment = range.cloneContents();
  const container = document.createElement("div");
  container.appendChild(fragment);
  return extractTextWithPills(container);
}

/**
 * Collect terminal/session/browser pill texts (the ones that have a backing
 * entry in `pillTokens` storage). Mirrors `collectContextPillTexts` from the
 * ComposerInput implementation so `inputPreparation` can attach terminal blocks
 * to the agent prompt without changing.
 */
export function collectContextPillTextsFromDom(
  root: HTMLElement
): Record<string, string> {
  const texts: Record<string, string> = {};
  const pillNodes = root.querySelectorAll<HTMLElement>(`[${PILL_DATA_ATTR}]`);
  pillNodes.forEach((element) => {
    const attrs = readPillAttrs(element);
    const iconType = attrs.iconType ?? "";
    const prefix = CONTEXT_PILL_PREFIXES[iconType];
    if (prefix && attrs.filePath.startsWith(prefix)) {
      const stored = readPillText(attrs.filePath);
      if (stored) texts[attrs.filePath] = stored;
    }
  });
  return texts;
}

/**
 * Snapshot every pill in document order. Used by `getFilePills()` and by
 * `useInputFormatter` when it relativizes paths against the repo root.
 */
export function snapshotPillsFromDom(root: HTMLElement): Array<{
  filePath: string;
  fileName: string;
  lineStart?: number;
  lineEnd?: number;
}> {
  const pillNodes = root.querySelectorAll<HTMLElement>(`[${PILL_DATA_ATTR}]`);
  const result: Array<{
    filePath: string;
    fileName: string;
    lineStart?: number;
    lineEnd?: number;
  }> = [];
  pillNodes.forEach((element) => {
    const attrs = readPillAttrs(element);
    result.push({
      filePath: attrs.filePath,
      fileName: attrs.fileName,
      lineStart: attrs.lineStart ?? undefined,
      lineEnd: attrs.lineEnd ?? undefined,
    });
  });
  return result;
}
