/**
 * diffSessionReplay.finalDiffSection
 *
 * Converts a canonical orgtrack `OrgtrackSessionFinalDiff` record into the
 * `DiffFileNavigationItem` shape the sidebar/detail list renders. Split out
 * of `index.tsx` so it stays independently unit-testable — see
 * `finalDiffToSection.test.ts`, which imports it via the `index.tsx`
 * re-export.
 */
import { type OrgtrackSessionFinalDiff } from "@src/api/tauri/lineage";
import { parseUnifiedDiffToOldNew } from "@src/engines/SessionCore/rendering/props/propsDataExtractors";
import {
  type DiffFileNavigationItem,
  type DiffFileSectionData,
} from "@src/modules/WorkStation/shared";

/** Exported for unit testing. */
export function finalDiffToSection(
  finalDiff: OrgtrackSessionFinalDiff
): DiffFileNavigationItem<DiffFileSectionData> {
  const isDeleted = Boolean(finalDiff.isDeleted);
  const parsedDiff = finalDiff.diff
    ? parseUnifiedDiffToOldNew(finalDiff.diff, { preserveHunkGaps: false })
    : undefined;
  const contentUnavailable =
    !finalDiff.diff && !finalDiff.oldContent && !finalDiff.newContent;
  const oldContent = contentUnavailable
    ? undefined
    : (finalDiff.oldContent ?? parsedDiff?.oldValue ?? "");
  const newContent = contentUnavailable
    ? undefined
    : isDeleted
      ? ""
      : (finalDiff.newContent ?? parsedDiff?.newValue ?? "");

  return {
    key: finalDiff.filePath,
    file: {
      path: finalDiff.filePath,
      status: isDeleted ? "deleted" : "modified",
      staged: false,
      additions: finalDiff.linesAdded,
      deletions: finalDiff.linesRemoved,
      oldContent,
      newContent,
      oldStartLine: parsedDiff?.oldStartLine,
      newStartLine: parsedDiff?.newStartLine,
      unifiedDiff: finalDiff.diff || undefined,
      isUnavailable: contentUnavailable || undefined,
    },
    entryIds: [finalDiff.recordId],
  };
}
