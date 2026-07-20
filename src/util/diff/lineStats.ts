import type { LineDiffStats } from "./types";
import { countUnifiedDiffLines } from "./unifiedDiff";

export interface ResolveLineDiffStatsOptions {
  additions?: number;
  deletions?: number;
  unifiedDiff?: string;
  /** Full content used only when the caller knows the file is newly added. */
  addedContent?: string;
  /** Full content used only when the caller knows the file is deleted. */
  deletedContent?: string;
}

export function countContentLines(content: string | undefined): number {
  return content ? content.split("\n").length : 0;
}

/** Resolve each stat independently without inventing modified-file deltas. */
export function resolveLineDiffStats({
  additions,
  deletions,
  unifiedDiff,
  addedContent,
  deletedContent,
}: ResolveLineDiffStatsOptions): LineDiffStats {
  const parsed = unifiedDiff ? countUnifiedDiffLines(unifiedDiff) : undefined;
  return {
    additions:
      additions ?? parsed?.additions ?? countContentLines(addedContent),
    deletions:
      deletions ?? parsed?.deletions ?? countContentLines(deletedContent),
  };
}
