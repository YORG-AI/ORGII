/**
 * Edit / apply_patch / diff data extractors.
 *
 * Handles single-file edits, multi-file apply_patch, and Rust-side
 * `PatchConversionResult` segments.
 */
import { getFileName } from "@src/util/file/pathUtils";

import type {
  ExtractedEditData,
  RustPatchConversionResult,
  UniversalEventProps,
} from "../types/universalProps";
import {
  cacheKey,
  detectLanguage,
  evictAndSet,
  extractSuccessData,
} from "./extractorShared";
import { extractFileData } from "./fileExtractors";

const HUNK_HEADER_REGEX = /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/m;
const DIFF_CODE_FENCE_REGEX = /```diff\s*\n([\s\S]*?)\n```/;
const HUNK_MARKER_REGEX = /^@@/;

interface DiffLineMeta {
  oldStartLine?: number;
  newStartLine?: number;
}

function extractFencedDiff(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const match = DIFF_CODE_FENCE_REGEX.exec(text);
  return match?.[1]?.trimEnd();
}

function parseDiffLineMeta(diff: string | undefined): DiffLineMeta {
  if (!diff) return {};
  const match = HUNK_HEADER_REGEX.exec(diff);
  if (!match) return {};
  return {
    oldStartLine: Number.parseInt(match[1], 10),
    newStartLine: Number.parseInt(match[2], 10),
  };
}

// ============================================
// Main extractor
// ============================================

function patchTextFromArgs(
  args: UniversalEventProps["args"]
): string | undefined {
  if (typeof args?.patch_text === "string") return args.patch_text;
  if (typeof args?.patch === "string") return args.patch;
  if (typeof args?.input === "string") return args.input;
  return undefined;
}

function isPatchPlaceholder(edit: ExtractedEditData): boolean {
  const filePath = edit.filePath.trim();
  const fileName = edit.fileName.trim();
  return (
    !edit.applyPatchSegments?.length &&
    (!filePath || filePath === "patch") &&
    (!fileName || fileName === "patch")
  );
}

export function extractEditData(props: UniversalEventProps): ExtractedEditData {
  if (props.rustExtracted?.kind === "edit") {
    const rust = props.rustExtracted;
    const segments = rust.applyPatchSegments ?? [];
    const applyPatchSegments =
      segments.length > 0
        ? segments.map((seg) => ({
            filePath: seg.filePath,
            fileName: seg.fileName,
            language: seg.language,
            content: seg.content,
            lineCount: seg.lineCount,
            oldContent: seg.oldContent,
            newContent: seg.newContent,
            diff: seg.diff,
            oldStartLine: seg.oldStartLine,
            newStartLine: seg.newStartLine,
            linesAdded: seg.linesAdded,
            linesRemoved: seg.linesRemoved,
            isDeleted: seg.isDeleted || undefined,
          }))
        : undefined;
    const editData = {
      filePath: rust.filePath,
      fileName: rust.fileName,
      content: rust.content,
      language: rust.language,
      lineCount: rust.lineCount,
      oldContent: rust.oldContent,
      newContent: rust.newContent,
      diff: rust.diff,
      oldStartLine: rust.oldStartLine,
      newStartLine: rust.newStartLine,
      linesAdded: rust.linesAdded,
      linesRemoved: rust.linesRemoved,
      isDeleted: rust.isDeleted || undefined,
      applyPatchSegments,
    };
    const patchText = patchTextFromArgs(props.args);
    if (patchText && isPatchPlaceholder(editData)) {
      return extractApplyPatchData(patchText, props.result);
    }
    return editData;
  }

  const { args, result } = props;

  const patchText = patchTextFromArgs(args);
  if (patchText) {
    return extractApplyPatchData(patchText, result);
  }

  const fileData = extractFileData(props);
  const successData = extractSuccessData(result);

  const oldContent =
    (args?.old_str as string) ||
    (args?.old_string as string) ||
    (args?.old_content as string) ||
    (successData?.beforeFullFileContent as string) ||
    (result?.old_content as string) ||
    undefined;

  // NOTE: args.content (OS Agent write_file) is checked before result.content
  // because result.content may be a status message like "Written 2541 bytes to..."
  const newContent =
    (args?.streamContent as string) ||
    (successData?.afterFullFileContent as string) ||
    (args?.new_str as string) ||
    (args?.new_string as string) ||
    (args?.new_content as string) ||
    (result?.new_content as string) ||
    (args?.content as string) ||
    (result?.content as string) ||
    undefined;

  const resultContent =
    typeof result?.content === "string" ? result.content : undefined;
  const resultOutput = result?.output as Record<string, unknown> | undefined;
  const diff =
    (successData?.diffString as string) ||
    (successData?.diff as string) ||
    (resultOutput?.diffString as string) ||
    (resultOutput?.diff as string) ||
    (result?.diffString as string) ||
    (result?.diff as string) ||
    extractFencedDiff(resultContent) ||
    undefined;
  const diffMeta = parseDiffLineMeta(diff);

  const linesAdded =
    (successData?.linesAdded as number) || (result?.linesAdded as number);
  const linesRemoved =
    (successData?.linesRemoved as number) || (result?.linesRemoved as number);

  const isFullWrite = !diff && !oldContent && newContent && !linesAdded;
  const computedLinesAdded = isFullWrite
    ? newContent.split("\n").length
    : linesAdded;

  return {
    ...fileData,
    oldContent,
    newContent,
    diff,
    oldStartLine: diffMeta.oldStartLine,
    newStartLine: diffMeta.newStartLine,
    linesAdded: computedLinesAdded,
    linesRemoved: linesRemoved,
  };
}

// ============================================
// apply_patch helpers
// ============================================

/**
 * Synchronous apply_patch extractor for the render `useMemo` path.
 * Produces combined diff + line counts but **no** per-file segments.
 * Callers that need segments should use `extractApplyPatchDataFromRust`
 * with the result of the Rust `es_convert_patch_to_diff` command.
 */
function extractApplyPatchData(
  patchText: string,
  result: Record<string, unknown> | undefined
): ExtractedEditData {
  const parsed = convertPatchToUnifiedDiffSync(patchText);
  const resultSummary =
    typeof result?.content === "string"
      ? (result.content as string)
      : undefined;

  const firstPath = parsed.filePaths.length > 0 ? parsed.filePaths[0] : "";
  const rawFileName = getFileName(firstPath) || "patch";

  const applyPatchSegments = splitCombinedDiffIntoSegments(parsed.diff).map(
    (segment) =>
      parsed.hasExplicitHunkHeaders
        ? segment
        : {
            ...segment,
            oldStartLine: undefined,
            newStartLine: undefined,
          }
  );

  const diffMeta = parsed.hasExplicitHunkHeaders
    ? parseDiffLineMeta(parsed.diff)
    : {};

  return {
    filePath: firstPath,
    fileName: rawFileName,
    content: undefined,
    language: "diff",
    lineCount: undefined,
    oldContent: undefined,
    newContent: parsed.diff ? undefined : resultSummary,
    diff: parsed.diff || undefined,
    oldStartLine: diffMeta.oldStartLine,
    newStartLine: diffMeta.newStartLine,
    linesAdded: parsed.linesAdded,
    linesRemoved: parsed.linesRemoved,
    applyPatchSegments:
      applyPatchSegments.length > 0 ? applyPatchSegments : undefined,
  };
}

export function splitCombinedDiffIntoSegments(
  combinedDiff: string
): ExtractedEditData[] {
  if (!combinedDiff) return [];

  const diffLines = combinedDiff.split("\n");
  const segments: ExtractedEditData[] = [];
  let currentLines: string[] = [];
  let currentPath = "";
  let isDelete = false;

  const flushSegment = () => {
    if (!currentPath || currentLines.length === 0) return;

    if (isDelete) {
      segments.push({
        filePath: currentPath,
        fileName: getFileName(currentPath),
        language: currentPath.split(".").pop() || "text",
        linesAdded: 0,
        linesRemoved: 0,
        isDeleted: true,
      });
      currentLines = [];
      isDelete = false;
      return;
    }

    let added = 0;
    let removed = 0;
    for (const line of currentLines) {
      if (line.startsWith("+") && !line.startsWith("+++")) added++;
      else if (line.startsWith("-") && !line.startsWith("---")) removed++;
    }
    const ext = currentPath.split(".").pop() || "text";
    const diff = currentLines.join("\n");
    const diffMeta = parseDiffLineMeta(diff);
    segments.push({
      filePath: currentPath,
      fileName: getFileName(currentPath),
      language: ext,
      diff,
      oldStartLine: diffMeta.oldStartLine,
      newStartLine: diffMeta.newStartLine,
      linesAdded: added,
      linesRemoved: removed,
    });
    currentLines = [];
  };

  for (const line of diffLines) {
    if (line.startsWith("--- ")) {
      flushSegment();
      currentLines.push(line);
      const nextPath = line.replace(/^--- /, "").replace(/^\/dev\/null$/, "");
      if (nextPath) currentPath = nextPath;
    } else if (line.startsWith("+++ ")) {
      currentLines.push(line);
      const nextPath = line.replace(/^\+\+\+ /, "");
      if (nextPath === "/dev/null") {
        isDelete = true;
      } else if (nextPath) {
        currentPath = nextPath;
      }
    } else {
      currentLines.push(line);
    }
  }
  flushSegment();

  return segments;
}

/**
 * Build `ExtractedEditData` (with `applyPatchSegments`) from a Rust
 * `PatchConversionResult` that already contains per-file segments.
 * Used by the playground and any async consumer that calls the Rust
 * `es_convert_patch_to_diff` Tauri command.
 */
export function extractApplyPatchDataFromRust(
  rustResult: RustPatchConversionResult,
  result: Record<string, unknown> | undefined
): ExtractedEditData {
  const resultSummary =
    typeof result?.content === "string"
      ? (result.content as string)
      : undefined;

  if (rustResult.segments.length === 0) {
    return {
      filePath: "",
      fileName: "patch",
      content: undefined,
      language: "diff",
      lineCount: undefined,
      oldContent: undefined,
      newContent: resultSummary,
      diff: undefined,
      linesAdded: 0,
      linesRemoved: 0,
    };
  }

  const applyPatchSegments = rustResult.segments.map((segment, segmentIndex) =>
    patchSegmentToExtractedEdit(
      segment,
      resultSummary,
      segmentIndex,
      rustResult.segments.length
    )
  );

  const first = applyPatchSegments[0];
  const diffMeta = parseDiffLineMeta(rustResult.diff);
  return {
    ...first,
    diff: rustResult.diff,
    oldStartLine: diffMeta.oldStartLine,
    newStartLine: diffMeta.newStartLine,
    linesAdded: rustResult.linesAdded,
    linesRemoved: rustResult.linesRemoved,
    applyPatchSegments,
  };
}

function patchSegmentToExtractedEdit(
  segment: {
    filePath: string;
    diff: string;
    linesAdded: number;
    linesRemoved: number;
    isDeleted: boolean;
    hasExplicitHunkHeader?: boolean;
  },
  resultSummary: string | undefined,
  segmentIndex: number,
  totalSegments: number
): ExtractedEditData {
  const rawFileName = getFileName(segment.filePath) || "patch";

  if (segment.isDeleted) {
    const detectedLang = detectLanguage(rawFileName);
    return {
      filePath: segment.filePath,
      fileName: rawFileName,
      language: detectedLang === "plaintext" ? "diff" : detectedLang,
      linesAdded: 0,
      linesRemoved: 0,
      isDeleted: true,
    };
  }

  const hasRealDiff = !!segment.diff;
  const detectedLang = detectLanguage(rawFileName);
  const language = detectedLang === "plaintext" ? "diff" : detectedLang;

  const diffMeta =
    segment.hasExplicitHunkHeader === false
      ? {}
      : parseDiffLineMeta(segment.diff);

  return {
    filePath: segment.filePath,
    fileName: rawFileName,
    content: undefined,
    language: hasRealDiff ? "diff" : language,
    lineCount: undefined,
    oldContent: undefined,
    newContent:
      !hasRealDiff && segmentIndex === totalSegments - 1
        ? resultSummary
        : undefined,
    diff: hasRealDiff ? segment.diff : undefined,
    oldStartLine: diffMeta.oldStartLine,
    newStartLine: diffMeta.newStartLine,
    linesAdded: segment.linesAdded,
    linesRemoved: segment.linesRemoved,
  };
}

// ============================================
// Minimal sync patch converter (no segments)
// ============================================

interface SyncPatchResult {
  diff: string;
  filePaths: string[];
  linesAdded: number;
  linesRemoved: number;
  hasExplicitHunkHeaders: boolean;
}

const MAX_PATCH_CACHE = 50;
const patchCache = new Map<string, SyncPatchResult>();

/**
 * Minimal synchronous patch-to-unified-diff converter.
 * Produces combined diff + file paths + line counts but does NOT produce
 * per-file segments — the Rust backend is the source of truth for those.
 */
function convertPatchToUnifiedDiffSync(patchText: string): SyncPatchResult {
  const key = cacheKey(patchText);
  const cached = patchCache.get(key);
  if (cached) return cached;

  const lines = patchText.split("\n");
  const diffLines: string[] = [];
  const filePaths: string[] = [];
  let currentFile = "";
  let isAddFile = false;
  let isDeleteFile = false;
  let sectionLines: string[] = [];
  let totalAdded = 0;
  let totalRemoved = 0;
  let hasExplicitHunkHeaders = false;

  const flushSection = () => {
    if (!currentFile || (sectionLines.length === 0 && !isDeleteFile)) return;
    const bodyLines = sectionLines.filter(
      (line) => !HUNK_MARKER_REGEX.test(line)
    );
    const hasExplicitHunkHeader = sectionLines.some((line) =>
      HUNK_HEADER_REGEX.test(line)
    );
    hasExplicitHunkHeaders ||= isAddFile || hasExplicitHunkHeader;
    if (isDeleteFile) {
      diffLines.push(`--- ${currentFile}`);
      diffLines.push("+++ /dev/null");
      diffLines.push(`@@ -1,${sectionLines.length} +0,0 @@`);
    } else if (isAddFile) {
      diffLines.push("--- /dev/null");
      diffLines.push(`+++ ${currentFile}`);
      diffLines.push(`@@ -0,0 +1,${bodyLines.length} @@`);
    } else {
      diffLines.push(`--- ${currentFile}`);
      diffLines.push(`+++ ${currentFile}`);
      if (!hasExplicitHunkHeader) {
        let added = 0;
        let removed = 0;
        let context = 0;
        for (const sl of bodyLines) {
          if (sl.startsWith("+")) added++;
          else if (sl.startsWith("-")) removed++;
          else context++;
        }
        diffLines.push(`@@ -1,${removed + context} +1,${added + context} @@`);
      }
    }
    for (const sl of sectionLines) {
      if (HUNK_MARKER_REGEX.test(sl) && !HUNK_HEADER_REGEX.test(sl)) {
        continue;
      }
      if (sl.startsWith("+")) totalAdded++;
      else if (sl.startsWith("-")) totalRemoved++;
      diffLines.push(sl);
    }
    sectionLines = [];
  };

  for (const line of lines) {
    const addMatch = line.match(/^\*\*\*\s+Add\s+File:\s+(.+)/);
    const modifyMatch = line.match(
      /^\*\*\*\s+(?:Modify|Update)\s+File:\s+(.+)/
    );
    const deleteMatch = line.match(/^\*\*\*\s+Delete\s+File:\s+(.+)/);
    const moveMatch = line.match(/^\*\*\*\s+Move\s+to:\s+(.+)/);

    if (addMatch) {
      flushSection();
      currentFile = addMatch[1].trim();
      filePaths.push(currentFile);
      isAddFile = true;
      isDeleteFile = false;
      continue;
    }
    if (modifyMatch) {
      flushSection();
      currentFile = modifyMatch[1].trim();
      filePaths.push(currentFile);
      isAddFile = false;
      isDeleteFile = false;
      continue;
    }
    if (deleteMatch) {
      flushSection();
      currentFile = deleteMatch[1].trim();
      filePaths.push(currentFile);
      isAddFile = false;
      isDeleteFile = true;
      continue;
    }
    if (moveMatch) {
      const movedFile = moveMatch[1].trim();
      if (movedFile) {
        currentFile = movedFile;
        filePaths[filePaths.length - 1] = movedFile;
      }
      continue;
    }
    if (
      line.startsWith("*** Begin Patch") ||
      line.startsWith("*** End Patch")
    ) {
      continue;
    }
    if (currentFile) {
      sectionLines.push(line);
    }
  }
  flushSection();

  const syncResult: SyncPatchResult = {
    diff: diffLines.join("\n"),
    filePaths,
    linesAdded: totalAdded,
    linesRemoved: totalRemoved,
    hasExplicitHunkHeaders,
  };
  evictAndSet(patchCache, key, syncResult, MAX_PATCH_CACHE);
  return syncResult;
}
