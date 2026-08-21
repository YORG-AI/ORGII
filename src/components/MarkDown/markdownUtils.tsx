/**
 * markdownUtils
 *
 * Pure utility functions extracted from MarkDownImpl.tsx:
 * - preprocessTextContent: auto-detect and wrap unformatted code
 * - detectCodeType: classify inline code as file / directory / identifier
 * - openFileInEditor: dispatch event to open file in editor
 * - openUrlInBrowserApp: dispatch event to open URL in browser
 * - isLocalhostUrl: detect localhost URLs
 * - renderMessageWithCitations: render [N] citation references
 * - renderChildren: recursively apply citation rendering to React nodes
 */
import React from "react";

import { openFileInEditor as openFileInEditorShared } from "@src/util/ui/openFileInEditor";

import { parseMarkdownFileRef } from "./markdownFileRef";

type InlineCodeType = "file" | "directory" | null;

const FILE_CONTENT_PATTERN =
  /((Here's the content of|Content of|Read\.?\s*Highlights? from|Read)\s+`([^`]+)`\s*:)\s*\n*([^]*?)(?=\n\n[A-Z]|$)/gi;

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  tsx: "tsx",
  jsx: "jsx",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  cpp: "cpp",
  c: "c",
  cs: "csharp",
  php: "php",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  json: "json",
  md: "markdown",
  css: "css",
  scss: "scss",
  html: "html",
  xml: "xml",
  sql: "sql",
};

const CODE_PATTERNS = [
  /^'use strict'/m,
  /^"use strict"/m,
  /^module\.exports/m,
  /^const\s+\w+\s*=/m,
  /^let\s+\w+\s*=/m,
  /^var\s+\w+\s*=/m,
  /^function\s+\w+\s*\(/m,
  /^class\s+\w+/m,
  /^import\s+.*from/m,
  /^export\s+(default\s+)?/m,
  /^#!\//m,
];

const ASCII_DIAGRAM_HINT_PATTERN = /[│├─└┌┐┘┤┬┴┼┃╔╗╚╝╠╣╦╩╬━|+=\\]/;
const COPYABLE_MARKDOWN_DOCUMENT_PATTERN =
  /^(\s*)(`{3,})(md|markdown)([^\n]*)\n([\s\S]*?)\n(`{3,})(\s*)$/i;
const FENCE_RUN_PATTERN = /`{3,}/g;
const MAX_INLINE_CODE_CACHE_SIZE = 300;
const inlineCodeTypeCache = new Map<string, InlineCodeType>();

function setInlineCodeTypeCache(key: string, value: InlineCodeType): void {
  if (inlineCodeTypeCache.size >= MAX_INLINE_CODE_CACHE_SIZE) {
    const firstKey = inlineCodeTypeCache.keys().next().value;
    if (firstKey !== undefined) inlineCodeTypeCache.delete(firstKey);
  }
  inlineCodeTypeCache.set(key, value);
}

// ── openUrlInBrowserApp ───────────────────────────────────────────────────────

export interface OpenUrlInBrowserOptions {
  navigate?: boolean;
}

export function openUrlInBrowserApp(
  url: string,
  options: OpenUrlInBrowserOptions = {}
): void {
  window.dispatchEvent(
    new CustomEvent("open-url-in-browser", {
      detail: { url, navigate: options.navigate === true },
    })
  );
}

// ── isLocalhostUrl ────────────────────────────────────────────────────────────

export function isLocalhostUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === "localhost" ||
      parsed.hostname === "127.0.0.1" ||
      parsed.hostname === "::1"
    );
  } catch {
    return false;
  }
}

// ── preprocessTextContent ─────────────────────────────────────────────────────

function mayContainFileContentPattern(text: string): boolean {
  if (!text.includes("`") || !text.includes(":")) return false;

  const lowerText = text.toLowerCase();
  return (
    lowerText.includes("here's the content of") ||
    lowerText.includes("content of") ||
    lowerText.includes("read")
  );
}

function mayContainUnformattedCode(text: string): boolean {
  if (text.includes("```")) return false;

  return (
    text.startsWith("'use strict'") ||
    text.startsWith('"use strict"') ||
    text.startsWith("module.exports") ||
    text.startsWith("const ") ||
    text.startsWith("let ") ||
    text.startsWith("var ") ||
    text.startsWith("function ") ||
    text.startsWith("class ") ||
    text.startsWith("import ") ||
    text.startsWith("export ") ||
    text.startsWith("#!/") ||
    text.includes("\n'use strict'") ||
    text.includes('\n"use strict"') ||
    text.includes("\nmodule.exports") ||
    text.includes("\nconst ") ||
    text.includes("\nlet ") ||
    text.includes("\nvar ") ||
    text.includes("\nfunction ") ||
    text.includes("\nclass ") ||
    text.includes("\nimport ") ||
    text.includes("\nexport ") ||
    text.includes("\n#!/")
  );
}

function mayContainAsciiDiagram(text: string): boolean {
  const firstNewline = text.indexOf("\n");
  if (firstNewline < 0) return false;

  const secondNewline = text.indexOf("\n", firstNewline + 1);
  if (secondNewline < 0) return false;

  return ASCII_DIAGRAM_HINT_PATTERN.test(text);
}

export function containsMarkdownFence(text: string): boolean {
  return /(^|\n)\s*`{3,}/.test(text);
}

export function normalizeCopyableMarkdownDocumentFence(text: string): string {
  const match = text.match(COPYABLE_MARKDOWN_DOCUMENT_PATTERN);
  if (!match) return text;

  const [
    ,
    leadingWhitespace,
    openingFence,
    language,
    openingSuffix,
    body,
    closingFence,
    trailingWhitespace,
  ] = match;

  if (openingFence.length !== closingFence.length) return text;
  if (!body.includes(openingFence)) return text;

  const maxFenceLength = Math.max(
    openingFence.length,
    ...Array.from(body.matchAll(FENCE_RUN_PATTERN), ([fence]) => fence.length)
  );
  const wrapperFence = "`".repeat(maxFenceLength + 1);

  return `${leadingWhitespace}${wrapperFence}${language}${openingSuffix}\n${body}\n${wrapperFence}${trailingWhitespace}`;
}

/**
 * Detects and formats unformatted code in text content.
 * Handles cases where the backend sends raw code without markdown formatting.
 */
export function preprocessTextContent(text: string): string {
  if (!text) return text;

  const shouldCheckFileContent = mayContainFileContentPattern(text);
  const shouldCheckUnformattedCode = mayContainUnformattedCode(text);
  const shouldCheckAsciiDiagram = mayContainAsciiDiagram(text);

  if (
    !shouldCheckFileContent &&
    !shouldCheckUnformattedCode &&
    !shouldCheckAsciiDiagram
  ) {
    return text;
  }

  if (shouldCheckFileContent) {
    text = text.replace(
      FILE_CONTENT_PATTERN,
      (match, prefix, _verb, filePath, codeContent) => {
        if (codeContent.trim().startsWith("```")) return match;

        const ext = filePath.split(".").pop()?.toLowerCase() || "";
        const lang = LANGUAGE_BY_EXTENSION[ext] || "text";
        const cleanCode = codeContent.trim();
        if (!cleanCode) return prefix;
        return `${prefix}\n\n\`\`\`${lang}\n${cleanCode}\n\`\`\``;
      }
    );
  }

  const hasUnformattedCode =
    shouldCheckUnformattedCode &&
    CODE_PATTERNS.some((pattern) => pattern.test(text));

  if (hasUnformattedCode && !text.includes("```")) {
    const lines = text.split("\n");
    let inCodeBlock = false;
    let codeLines: string[] = [];
    const resultLines: string[] = [];

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const isCodeLine =
        CODE_PATTERNS.some((pattern) => pattern.test(line)) ||
        (inCodeBlock &&
          (line.startsWith("  ") ||
            line.startsWith("\t") ||
            line.match(/^[{}();]/) ||
            line.match(/^\s*\/[/*]/) ||
            line.match(/require\(/) ||
            line.match(/^\s*\}/) ||
            line.match(/^\s*\)/)));

      if (isCodeLine && !inCodeBlock) {
        inCodeBlock = true;
        codeLines = [line];
      } else if (isCodeLine && inCodeBlock) {
        codeLines.push(line);
      } else if (!isCodeLine && inCodeBlock) {
        if (codeLines.length > 0) {
          resultLines.push("```javascript");
          resultLines.push(...codeLines);
          resultLines.push("```");
        }
        inCodeBlock = false;
        codeLines = [];
        resultLines.push(line);
      } else {
        resultLines.push(line);
      }
    }

    if (inCodeBlock && codeLines.length > 0) {
      resultLines.push("```javascript");
      resultLines.push(...codeLines);
      resultLines.push("```");
    }

    text = resultLines.join("\n");
  }

  if (shouldCheckAsciiDiagram) {
    text = wrapAsciiDiagrams(text);
  }

  return text;
}

/**
 * Finds runs of 3+ consecutive lines that look like ASCII diagrams (box-drawing
 * chars, pipe-heavy, or indented tree lines) and wraps each run in a plain text
 * code fence, unless they are already inside a fenced block.
 */
function wrapAsciiDiagrams(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inFence = false;
  let runStart = -1;
  const runLines: string[] = [];

  function isAsciiDiagramLine(line: string): boolean {
    if (!line.trim()) return false;
    // Box-drawing Unicode characters
    if (/^[\s]*[│├─└┌┐┘┤┬┴┼┃╔╗╚╝╠╣╦╩╬━]/.test(line)) return true;
    // Lines that are mostly pipes / dashes (ASCII art / table)
    const stripped = line.replace(/\s/g, "");
    if (stripped.length >= 3 && /^[|+=>\\/-]+$/.test(stripped)) return true;
    // Pipe at start of line with content
    if (/^\s*[|]/.test(line) && /[|]/.test(line.slice(line.indexOf("|") + 1)))
      return true;
    // Tree-style lines: ├── or └── or |--
    if (/^[\s]*[├└|]\s*[-─]/.test(line)) return true;
    return false;
  }

  function flush() {
    if (runStart < 0) return;
    const run = runLines.splice(0);
    if (run.length >= 3) {
      result.push("```");
      result.push(...run);
      result.push("```");
    } else {
      result.push(...run);
    }
    runStart = -1;
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx];

    // Track code fences so we never re-wrap already-fenced content
    if (/^```/.test(line.trim())) {
      if (inFence) {
        inFence = false;
        flush();
        result.push(line);
      } else {
        flush();
        inFence = true;
        result.push(line);
      }
      continue;
    }

    if (inFence) {
      result.push(line);
      continue;
    }

    if (isAsciiDiagramLine(line)) {
      if (runStart < 0) runStart = idx;
      runLines.push(line);
    } else {
      flush();
      result.push(line);
    }
  }

  flush();
  return result.join("\n");
}

// ── detectCodeType ────────────────────────────────────────────────────────────

/**
 * Check if a string looks like a file path or code identifier.
 * Returns the detected type: 'file', 'directory', 'identifier', or null.
 */
export function detectCodeType(text: string): InlineCodeType {
  if (!text || text.length > 200) return null;
  const trimmed = text.trim();

  if (inlineCodeTypeCache.has(trimmed)) {
    return inlineCodeTypeCache.get(trimmed) ?? null;
  }

  let result: InlineCodeType = null;
  const fileRefPath = parseMarkdownFileRef(trimmed).path;

  if (
    !fileRefPath.includes("\n") &&
    !fileRefPath.includes("  ") &&
    !/[=<>!&|]/.test(fileRefPath)
  ) {
    const hasPathSignal =
      fileRefPath.includes("/") || fileRefPath.endsWith("/");

    if (hasPathSignal && /^[\w./-]+\/$/.test(fileRefPath)) {
      result = "directory";
    } else if (
      hasPathSignal &&
      (/^\.{0,2}\//.test(fileRefPath) ||
        (/\//.test(fileRefPath) && /\.\w+$/.test(fileRefPath)))
    ) {
      result = "file";
    } else if (
      hasPathSignal &&
      /^[\w.-]+\/[\w./-]+$/.test(fileRefPath) &&
      !/\.\w+$/.test(fileRefPath)
    ) {
      result = "directory";
    }
  }

  setInlineCodeTypeCache(trimmed, result);
  return result;
}

// ── openFileInEditor ──────────────────────────────────────────────────────────

export function openFileInEditor(path: string, isDirectory: boolean = false) {
  const fileRef = isDirectory
    ? { path: path.trim() }
    : parseMarkdownFileRef(path);
  openFileInEditorShared(fileRef.path, {
    isDirectory,
    line: fileRef.line,
  });
}

// ── Citation rendering ────────────────────────────────────────────────────────

export const renderMessageWithCitations = (message: string) => {
  const parts = message.split(/(\[\d+\])/g);
  return parts.map((part, index) => {
    const match = part.match(/\[(\d+)\]/);
    if (match) {
      const citeCount = parseInt(match[1], 10);
      return (
        <span key={index} className="cite-reference">
          [{citeCount}]
        </span>
      );
    }
    return part;
  });
};

interface ChildrenProps {
  children?: React.ReactNode;
}

export const renderChildren = (children: React.ReactNode): React.ReactNode => {
  if (typeof children === "string") return renderMessageWithCitations(children);
  if (Array.isArray(children)) {
    return children.map((child, index) => (
      <React.Fragment key={index}>{renderChildren(child)}</React.Fragment>
    ));
  }
  if (React.isValidElement(children)) {
    const element = children as React.ReactElement<ChildrenProps>;
    return React.cloneElement(element, {
      children: renderChildren(element.props.children),
    });
  }
  if (typeof children === "object" && children !== null) {
    return React.Children.map(children, (child) => renderChildren(child));
  }
  return children;
};
