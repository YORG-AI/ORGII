/**
 * markdownCodeFence
 *
 * Fenced-block metadata for the markdown renderer: which fenced languages
 * become a Canvas card, which ones render without a title bar, and how the
 * `startLine:endLine:path` info string maps onto a code reference.
 */
import { getLanguageFromPath } from "@src/config/languageMap";

/**
 * Fenced language aliases that trigger CanvasInlineCard instead of a code
 * block. The agent writes ```canvas or ```preview with a JSON payload.
 *
 * Payload schema (JSON on a single line or pretty-printed):
 *   { "mode": "html"|"url"|"a2ui"|"react", "content"?: "...", "url"?: "...", "title"?: "..." }
 */
export const CANVAS_FENCED_LANGUAGES = new Set([
  "canvas",
  "preview",
  "canvas-html",
  "canvas-url",
  "canvas-a2ui",
  "canvas-react",
]);

export type CanvasFencedMode = "html" | "url" | "a2ui" | "react";

export function isCanvasFencedMode(value: unknown): value is CanvasFencedMode {
  return (
    value === "html" || value === "url" || value === "a2ui" || value === "react"
  );
}

/**
 * Fenced languages whose title bar adds little value next to the snippet itself.
 * File-backed code references still keep their header because `filePath` is set.
 */
export const CHAT_CODE_BLOCK_HIDE_HEADER_LANGUAGES = new Set([
  "bash",
  "fish",
  "plaintext",
  "powershell",
  "ps1",
  "sh",
  "shell",
  "text",
  "txt",
  "zsh",
]);

export interface CodeFenceMeta {
  language: string;
  filePath?: string;
  title?: string;
  startLine?: string;
  endLine?: string;
}

export function parseCodeFenceMeta(rawInfo: string): CodeFenceMeta {
  const referenceMatch = rawInfo.match(/^(\d+):(\d+):(.+)$/);
  if (referenceMatch) {
    const startLine = referenceMatch[1];
    const endLine = referenceMatch[2];
    const filePath = referenceMatch[3];
    const fileName = filePath.split("/").pop() || filePath;
    return {
      language: getLanguageFromPath(filePath, "text") || "text",
      filePath,
      title: fileName,
      startLine,
      endLine,
    };
  }

  return { language: rawInfo || "text" };
}
