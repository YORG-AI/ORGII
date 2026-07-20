import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { extractEditData } from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import { normalizeEventProps } from "@src/engines/SessionCore/rendering/props/propsNormalizer";
import { shouldTrustDiffStartLines } from "@src/util/diff/startLines";
import {
  mergeUnifiedDiffStrings,
  parseUnifiedDiffToOldNew,
} from "@src/util/diff/unifiedDiff";
import { normalizeDiffFilePath } from "@src/util/file/pathUtils";

import type { DiffFileSectionData } from "../DiffFileSection";
import type { DiffSectionListItem } from "./index";

export interface SessionReplayDiffEntryLike {
  entryId: string;
  event: SessionEvent;
  filePath: string;
  fileName: string;
}

export interface SessionReplayDiffSectionItem extends DiffSectionListItem<DiffFileSectionData> {
  entryIds: string[];
  /** Raw compact diff strings from each edit, used for multi-hunk merge during consolidation. */
  rawDiffs: string[];
}

function getDiffStatus(
  entry: SessionReplayDiffEntryLike,
  isDeleted: boolean | undefined,
  oldContent: string | undefined,
  newContent: string | undefined
): DiffFileSectionData["status"] {
  const action =
    typeof entry.event.args?.action === "string" ? entry.event.args.action : "";
  const functionName = entry.event.functionName || "";
  if (
    isDeleted ||
    action.includes("delete") ||
    functionName.includes("delete")
  ) {
    return "deleted";
  }
  if (action.includes("create") || (!oldContent && Boolean(newContent))) {
    return "added";
  }
  return "modified";
}

export function buildSessionReplayDiffSectionItems(
  entry: SessionReplayDiffEntryLike
): SessionReplayDiffSectionItem[] {
  const universal = normalizeEventProps({ event: entry.event }, "tool_call");
  if (!universal) return [];

  const editData = extractEditData(universal);
  const segments =
    editData.applyPatchSegments && editData.applyPatchSegments.length > 0
      ? editData.applyPatchSegments
      : [editData];

  return segments.flatMap((segment, index) => {
    const trustDiffStartLines = shouldTrustDiffStartLines(entry.event);
    // When a compact diff string is available, always parse it into
    // old/new values. This avoids passing full file bodies to CodeMirrorDiff
    // (which would show the entire file as context) and gives correct
    // oldStartLine/newStartLine from the hunk headers.
    const parsed = segment.diff
      ? parseUnifiedDiffToOldNew(segment.diff, { preserveHunkGaps: false })
      : undefined;
    const isDeleted = segment.isDeleted;
    const oldContent = isDeleted
      ? (parsed?.oldValue ?? segment.oldContent ?? segment.content ?? "")
      : (parsed?.oldValue ?? segment.oldContent ?? "");
    const newContent = isDeleted
      ? ""
      : (parsed?.newValue ?? segment.newContent ?? segment.content ?? "");
    const rawPath = segment.filePath || entry.filePath;
    const path = normalizeDiffFilePath(rawPath);
    if (!path) return [];
    const contentUnavailable = !oldContent && !newContent && !isDeleted;
    if (contentUnavailable) return [];

    return {
      key: `${entry.entryId}:${index}:${path}`,
      file: {
        path,
        status: getDiffStatus(entry, isDeleted, oldContent, newContent),
        staged: false,
        additions: segment.linesAdded,
        deletions: segment.linesRemoved,
        oldContent: contentUnavailable ? undefined : oldContent,
        newContent: contentUnavailable ? undefined : newContent,
        oldStartLine: trustDiffStartLines
          ? (segment.oldStartLine ?? parsed?.oldStartLine)
          : undefined,
        newStartLine: trustDiffStartLines
          ? (segment.newStartLine ?? parsed?.newStartLine)
          : undefined,
        showLineNumbers: trustDiffStartLines ? undefined : false,
        isUnavailable: contentUnavailable || undefined,
      },
      entryIds: [entry.entryId],
      rawDiffs: segment.diff ? [segment.diff] : [],
    };
  });
}

function mergeStatus(
  previous: DiffFileSectionData["status"],
  next: DiffFileSectionData["status"]
): DiffFileSectionData["status"] {
  if (next === "deleted") return "deleted";
  if (previous === "added" || next === "added") return "added";
  return "modified";
}

export function buildConsolidatedSessionReplayDiffSectionItems<
  TEntry extends SessionReplayDiffEntryLike,
>(entries: TEntry[]): SessionReplayDiffSectionItem[] {
  const byPath = new Map<string, SessionReplayDiffSectionItem>();

  for (const entry of entries) {
    for (const section of buildSessionReplayDiffSectionItems(entry)) {
      const path = section.file.path;
      const existing = byPath.get(path);
      if (!existing) {
        byPath.set(path, {
          key: path,
          file: { ...section.file },
          entryIds: [...section.entryIds],
          rawDiffs: [...section.rawDiffs],
        });
        continue;
      }

      existing.entryIds.push(...section.entryIds);
      existing.rawDiffs.push(...section.rawDiffs);

      // Merge stats and status
      existing.file = {
        ...existing.file,
        status: mergeStatus(existing.file.status, section.file.status),
        additions:
          existing.file.additions !== undefined ||
          section.file.additions !== undefined
            ? (existing.file.additions ?? 0) + (section.file.additions ?? 0)
            : undefined,
        deletions:
          existing.file.deletions !== undefined ||
          section.file.deletions !== undefined
            ? (existing.file.deletions ?? 0) + (section.file.deletions ?? 0)
            : undefined,
        showLineNumbers:
          existing.file.showLineNumbers === false ||
          section.file.showLineNumbers === false
            ? false
            : undefined,
      };

      // Re-derive old/new content from the accumulated raw diffs.
      // When all edits carry compact diff strings, merge them into one
      // multi-hunk diff and re-parse so CodeMirror sees a coherent old/new
      // pair. Fall back to the last edit's newContent when any edit lacks
      // a raw diff (e.g. create / fullContent overwrites).
      if (existing.rawDiffs.length > 0 && section.rawDiffs.length > 0) {
        const merged = mergeUnifiedDiffStrings(existing.rawDiffs);
        const parsed = parseUnifiedDiffToOldNew(merged, {
          preserveHunkGaps: false,
        });
        existing.file.oldContent = parsed.oldValue;
        existing.file.newContent = parsed.newValue;
        existing.file.oldStartLine = parsed.oldStartLine;
        existing.file.newStartLine = parsed.newStartLine;
      } else {
        // Fallback: keep first old, last new (imperfect but better than nothing)
        existing.file.newContent = section.file.newContent;
        existing.file.newStartLine =
          section.file.newStartLine ?? existing.file.newStartLine;
      }
    }
  }

  return Array.from(byPath.values());
}
