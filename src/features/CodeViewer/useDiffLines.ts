/**
 * useDiffLines - Hook for diff computation, language detection, expansion, and flattening.
 * Extracted from VirtualizedModernDiff for separation of concerns.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { getLanguageFromPath } from "@src/config/languageMap";
import { getLanguageFromFilePath } from "@src/util/editor/extension";

import { computeDiffProgressive } from "./progressiveDiff";
import type { DiffLine, DiffStats } from "./types";

export interface UseDiffLinesOptions {
  oldValue: string;
  newValue: string;
  filePath?: string;
  contextLines: number;
  collapseUnchanged: boolean;
  oldStartLine: number;
  newStartLine: number;
}

export interface UseDiffLinesResult {
  isComputing: boolean;
  diffLines: DiffLine[];
  flattenedLines: DiffLine[];
  collapseIndexMap: Map<number, number>;
  language: string | undefined;
  stats: DiffStats;
  handleExpand: (index: number) => void;
}

export function useDiffLines(options: UseDiffLinesOptions): UseDiffLinesResult {
  const {
    oldValue,
    newValue,
    filePath,
    contextLines,
    collapseUnchanged,
    oldStartLine,
    newStartLine,
  } = options;

  const [expandedSections, setExpandedSections] = useState<Set<number>>(
    new Set()
  );
  const [isComputing, setIsComputing] = useState(true);
  const [diffLines, setDiffLines] = useState<DiffLine[]>([]);

  // Detect language - use getLanguageFromFilePath for Prism compatibility
  const language = useMemo(
    () =>
      (filePath ? getLanguageFromFilePath(filePath) : undefined) ||
      getLanguageFromPath(filePath),
    [filePath]
  );

  // Compute diff via Rust (async, non-blocking)
  useEffect(() => {
    setIsComputing(true);
    setDiffLines([]);

    const cancel = computeDiffProgressive({
      oldValue,
      newValue,
      contextLines,
      collapseUnchanged,
      oldStartLine,
      newStartLine,
      onComplete: (lines: DiffLine[]) => {
        setDiffLines(lines);
        setIsComputing(false);
      },
    });

    return () => {
      cancel();
    };
  }, [
    oldValue,
    newValue,
    contextLines,
    collapseUnchanged,
    oldStartLine,
    newStartLine,
  ]);

  // Calculate stats
  const stats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    diffLines.forEach((line) => {
      if (line.type === "add") additions++;
      if (line.type === "remove") deletions++;
    });
    return { additions, deletions };
  }, [diffLines]);

  // Handle expand/collapse toggle
  const handleExpand = useCallback((index: number) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // Build flat list for virtualization (expand collapsed sections)
  // Also track collapse indices for stable key generation
  const { flattenedLines, collapseIndexMap } = useMemo(() => {
    const result: DiffLine[] = [];
    const collapseMap = new Map<number, number>();
    let collapseIndex = 0;

    diffLines.forEach((line, lineIndex) => {
      if (line.type === "collapse") {
        const currentCollapseIndex = collapseIndex;
        const isExpanded = expandedSections.has(currentCollapseIndex);
        const isLeadingCollapse = lineIndex === 0;

        if (isExpanded && line.collapsedLines) {
          line.collapsedLines.forEach((collapsedLine) => {
            result.push(collapsedLine);
          });
        } else if (!isLeadingCollapse) {
          result.push(line);
          collapseMap.set(result.length - 1, collapseIndex);
        }
        collapseIndex++;
      } else {
        result.push(line);
      }
    });

    return { flattenedLines: result, collapseIndexMap: collapseMap };
  }, [diffLines, expandedSections]);

  return {
    isComputing,
    diffLines,
    flattenedLines,
    collapseIndexMap,
    language,
    stats,
    handleExpand,
  };
}
