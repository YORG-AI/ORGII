/**
 * Paste handling for ComposerInput.
 *
 * Mirrors `ComposerInput/editorHandlers/pasteHandler.ts` priority order:
 *   1. Image files → forwarded to `onImagePaste`, paste suppressed.
 *   2. Composer fragment (`application/x-orgii-composer-fragment`) → re-insert
 *      text and pills from a prior cut/copy within the same editor.
 *   3. Terminal selection (`window.__orgiiLastTerminalCopy` within window) →
 *      insert a terminal pill, suppress paste.
 *   4. File reference (`application/x-orgii-file-reference`) → insert a
 *      file-reference pill with line range, suppress paste.
 *   5. Skill path or frontmatter → insert a skill pill, suppress paste.
 *   6. Otherwise, sanitize the plain-text payload and insert it manually so
 *      `contenteditable` does not pull in formatted HTML from the source.
 */
import { capPillText, storePillText } from "@src/config/pillTokens";
import { createLogger } from "@src/hooks/logger";
import {
  type ReferenceDragPillData,
  clearReferenceDragData,
  getReferenceDragPillData,
} from "@src/shared/dnd/referenceDragData";
import type { InstalledSkill } from "@src/types/extensions";
import { extractSkillNameFromPath } from "@src/util/skills/skillPath";

import type { ComposerFragmentPart } from "./cutHandler";
import type { ComposerPillAttrs } from "./types";
import { TERMINAL_COPY_MAX_AGE, sanitizeText } from "./utils";

const logger = createLogger("ComposerInput");

export interface PasteHandlerContext {
  insertPill: (attrs: ComposerPillAttrs) => void;
  insertTextAtCaret: (text: string) => void;
  getOnImagePaste: () => ((files: File[]) => void) | undefined;
  /** Returns the current installed-skills list for paste-time matching. */
  getInstalledSkills: () => InstalledSkill[];
}

export interface DropHandlerContext {
  insertPill: (attrs: ComposerPillAttrs) => void;
}

function insertReferencePill(
  ctx: DropHandlerContext,
  reference: ReferenceDragPillData
): void {
  storePillText(
    reference.pillPath,
    capPillText(JSON.stringify(reference.payload))
  );
  ctx.insertPill({
    filePath: reference.pillPath,
    fileName: reference.displayName,
    isFolder: false,
    iconType: reference.iconType,
    lineStart: null,
    lineEnd: null,
  });
}

/**
 * Returns a `drop` event handler for the contenteditable host that handles
 * PR/issue reference drag data created by source-control rows.
 * Returns `true` if the event was consumed.
 *
 * WKWebView (Tauri/macOS) strips custom MIME types from DataTransfer during
 * cross-element drags, so we fall back to the window-level drag stash when
 * `dataTransfer.getData()` returns an empty string.
 */
export function createDropHandler(ctx: DropHandlerContext) {
  return (event: DragEvent): boolean => {
    const reference = event.dataTransfer
      ? getReferenceDragPillData(event.dataTransfer)
      : null;
    if (!reference) return false;

    try {
      event.preventDefault();
      insertReferencePill(ctx, reference);
      return true;
    } finally {
      clearReferenceDragData(reference.type);
    }
  };
}

/**
 * Matches a SKILL.md frontmatter block and extracts the `name` field value.
 * Handles both full-file pastes and partial frontmatter snippets.
 */
function extractSkillNameFromFrontmatter(text: string): string | null {
  const match = text.match(/^---[\s\S]*?^name:\s*([^\s\r\n]+)/m);
  return match ? match[1].trim() : null;
}

/**
 * Finds an installed skill whose `name` or `path` matches the candidate name.
 * The path-based match normalises separators and compares the skill directory segment.
 */
function resolveSkill(
  candidateName: string,
  skills: InstalledSkill[]
): InstalledSkill | undefined {
  const lower = candidateName.toLowerCase();
  return skills.find((s) => {
    if (s.name.toLowerCase() === lower) return true;
    const normalised = s.path.replace(/\\/g, "/");
    const segments = normalised.split("/");
    const dirName = segments[segments.length - 2];
    return dirName?.toLowerCase() === lower;
  });
}

/**
 * Min length (chars) before a JSON paste is auto-converted to a pill. Below
 * this, we leave it as raw text so the user can still hand-type small JSON
 * snippets inline without losing them to a pill.
 */
const JSON_PASTE_MIN_LENGTH = 200;
const LARGE_TEXT_PASTE_MIN_LENGTH = 4_000;
const LARGE_TEXT_PASTE_MIN_LINES = 80;

/**
 * Detect "user pasted a chunk of JSON" and propose a pill display name.
 * Returns `null` if the paste is not JSON, is shorter than the threshold,
 * or fails to parse.
 *
 * The display-name heuristic walks the top-level object (and one level of
 * nesting for the `meta`/`reactComponent` patterns produced by DevTools
 * exports) looking for an identifier-like field.
 *
 * Exported for unit tests; the runtime branch in `createPasteHandler` is the
 * only production caller.
 */
export function looksLikePastedJson(
  text: string
): { suggestedName: string; pretty: string } | null {
  const trimmed = text.trim();
  if (trimmed.length < JSON_PASTE_MIN_LENGTH) return null;
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const namePicker = (
    obj: Record<string, unknown>,
    keys: readonly string[]
  ): string | null => {
    for (const k of keys) {
      const v = obj[k];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return null;
  };

  let suggested: string | null = null;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    suggested = namePicker(obj, ["name", "fileName", "id", "title"]);
    if (!suggested) {
      // One level of nesting for common DevTools-style payloads.
      const nested = obj["reactComponent"];
      if (nested && typeof nested === "object" && !Array.isArray(nested)) {
        suggested = namePicker(nested as Record<string, unknown>, [
          "name",
          "displayName",
        ]);
      }
    }
  }
  if (!suggested) suggested = "pasted";
  if (suggested.length > 32) suggested = suggested.slice(0, 32);

  const pretty = JSON.stringify(value, null, 2);
  return { suggestedName: `${suggested}.json`, pretty };
}

export function looksLikeLargePlainText(text: string): boolean {
  if (text.length >= LARGE_TEXT_PASTE_MIN_LENGTH) return true;
  let lineCount = 1;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) {
      lineCount += 1;
      if (lineCount >= LARGE_TEXT_PASTE_MIN_LINES) return true;
    }
  }
  return false;
}

/**
 * Returns a `paste` event handler suitable for attaching directly to the
 * contenteditable host. Returns `true` if the event was consumed.
 */
export function createPasteHandler(ctx: PasteHandlerContext) {
  return (event: ClipboardEvent): boolean => {
    const clipboardData = event.clipboardData;
    if (!clipboardData) return false;

    const imageFiles: File[] = [];
    for (let index = 0; index < clipboardData.items.length; index++) {
      const item = clipboardData.items[index];
      if (item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) imageFiles.push(file);
      }
    }
    const onImagePaste = ctx.getOnImagePaste();
    if (imageFiles.length > 0 && onImagePaste) {
      event.preventDefault();
      onImagePaste(imageFiles);
      return true;
    }

    // Composer fragment — rich paste from a prior cut/copy within this editor.
    // Handles text runs, newlines, and pills (with full metadata) in order.
    const fragmentData = clipboardData.getData(
      "application/x-orgii-composer-fragment"
    );
    if (fragmentData) {
      try {
        const parts = JSON.parse(fragmentData) as ComposerFragmentPart[];
        event.preventDefault();
        for (const part of parts) {
          if (part.kind === "text") {
            ctx.insertTextAtCaret(part.text);
          } else if (part.kind === "newline") {
            ctx.insertTextAtCaret("\n");
          } else if (part.kind === "pill") {
            ctx.insertPill(part.attrs);
          }
        }
        return true;
      } catch {
        // Malformed JSON — fall through to plain-text handling.
      }
    }

    const pastedText = clipboardData.getData("text/plain");

    const terminalCopy = window.__orgiiLastTerminalCopy;
    if (
      terminalCopy &&
      pastedText &&
      pastedText === terminalCopy.text &&
      Date.now() - terminalCopy.timestamp < TERMINAL_COPY_MAX_AGE
    ) {
      const terminalRef = { ...terminalCopy };
      window.__orgiiLastTerminalCopy = undefined;
      const lineCount = terminalRef.lineCount;
      const hasRange = lineCount > 1;
      const pillPath = `terminal://${terminalRef.sessionId}/${Date.now()}`;
      ctx.insertPill({
        filePath: pillPath,
        fileName: terminalRef.sessionName,
        isFolder: false,
        iconType: "terminal",
        lineStart: hasRange ? 1 : null,
        lineEnd: hasRange ? lineCount : null,
      });
      storePillText(pillPath, capPillText(terminalRef.text));
      event.preventDefault();
      return true;
    }

    const fileRefData = clipboardData.getData(
      "application/x-orgii-file-reference"
    );
    if (fileRefData) {
      try {
        const fileRef = JSON.parse(fileRefData) as {
          filePath: string;
          fileName: string;
          lineStart: number;
          lineEnd: number;
        };
        ctx.insertPill({
          filePath: fileRef.filePath,
          fileName: fileRef.fileName,
          isFolder: false,
          iconType: "file",
          lineStart: fileRef.lineStart,
          lineEnd: fileRef.lineEnd,
        });
        event.preventDefault();
        return true;
      } catch (parseError) {
        logger.warn("Failed to parse file reference:", parseError);
      }
    }

    // Large JSON paste — collapse into a `paste` pill so the editor doesn't
    // get blown out by DevTools / API blob dumps. The raw JSON is stashed in
    // `storePillText` keyed by `paste://...`; submit flow auto-appends it as
    // a fenced code block via `getTerminalPillTexts()` (which iterates every
    // `CONTEXT_PILL_PREFIXES` entry, not just terminal).
    if (pastedText) {
      const jsonHit = looksLikePastedJson(pastedText);
      if (jsonHit) {
        const pillPath = `paste://${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        ctx.insertPill({
          filePath: pillPath,
          fileName: jsonHit.suggestedName,
          isFolder: false,
          iconType: "paste",
          lineStart: null,
          lineEnd: null,
        });
        storePillText(pillPath, capPillText(jsonHit.pretty));
        event.preventDefault();
        return true;
      }
      if (looksLikeLargePlainText(pastedText)) {
        const pillPath = `paste://${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;
        ctx.insertPill({
          filePath: pillPath,
          fileName: "pasted.txt",
          isFolder: false,
          iconType: "paste",
          lineStart: null,
          lineEnd: null,
        });
        storePillText(pillPath, capPillText(sanitizeText(pastedText)));
        event.preventDefault();
        return true;
      }
    }

    // Skill path / frontmatter detection.
    // Try to resolve against the installed-skills list first (to get the
    // canonical name). If the atom hasn't loaded yet — or the pasted path
    // belongs to a skill that isn't listed — fall back to the extracted name
    // directly so the pill is still inserted instead of raw text.
    if (pastedText) {
      const candidateName =
        extractSkillNameFromPath(pastedText) ??
        extractSkillNameFromFrontmatter(pastedText);
      if (candidateName) {
        const skills = ctx.getInstalledSkills();
        const skill =
          skills.length > 0 ? resolveSkill(candidateName, skills) : undefined;
        const skillName = skill?.name ?? candidateName;
        event.preventDefault();
        ctx.insertPill({
          filePath: `/${skillName}`,
          fileName: skillName,
          isFolder: false,
          iconType: "skill",
          lineStart: null,
          lineEnd: null,
        });
        ctx.insertTextAtCaret(" ");
        logger.info("Pasted text converted to skill pill:", skillName);
        return true;
      }
    }

    // Fall back to a sanitized plain-text insert. We bypass the browser's
    // default paste to avoid letting Word/HTML formatting bleed into the
    // editor and to keep IME-tofu characters out of the document.
    if (pastedText) {
      event.preventDefault();
      ctx.insertTextAtCaret(sanitizeText(pastedText));
      return true;
    }

    return false;
  };
}
