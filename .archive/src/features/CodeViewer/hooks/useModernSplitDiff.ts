/**
 * useModernSplitDiff Hook
 *
 * Business logic for ModernSplitDiff component
 * Handles state management, selection, and diff computation
 */
import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { getLanguageFromPath } from "@src/config/languageMap";
import { createLogger } from "@src/hooks/logger";

import type {
  AlignedLine,
  ChangeRange,
  ChangeableIndices,
  DiffStats,
  ModernSplitDiffProps,
} from "../types";
import { collapseSplitViewLines } from "../utils/collapseLines";
import { computeAlignedDiffAsync } from "../utils/diffAlgorithm";

const log = createLogger("SplitDiff");

interface UseModernSplitDiffOptions {
  oldValue: string;
  newValue: string;
  filePath?: string;
  cherrypicking?: boolean;
  onSelectionChange?: ModernSplitDiffProps["onSelectionChange"];
  contextLines?: number;
  collapseUnchanged?: boolean;
}

export function useModernSplitDiff(options: UseModernSplitDiffOptions) {
  const {
    oldValue,
    newValue,
    filePath,
    cherrypicking = false,
    onSelectionChange,
    contextLines = 3,
    collapseUnchanged = true,
  } = options;

  const hasInitializedSelection = useRef(false);

  // State for expanded sections
  const [expandedSections, setExpandedSections] = useState<Set<number>>(
    new Set()
  );

  // Separate selection state for old (deletion) and new (addition) sides
  const [selectedOldLines, setSelectedOldLines] = useState<Set<number>>(
    () => new Set()
  );
  const [selectedNewLines, setSelectedNewLines] = useState<Set<number>>(
    () => new Set()
  );

  // Detect language from file path
  const language = useMemo(() => getLanguageFromPath(filePath), [filePath]);

  // Use deferred values for smoother file switching
  const deferredOldValue = useDeferredValue(oldValue);
  const deferredNewValue = useDeferredValue(newValue);
  const isPending =
    deferredOldValue !== oldValue || deferredNewValue !== newValue;

  // Compute aligned diff via Rust (async)
  const [rawAlignedLines, setRawAlignedLines] = useState<AlignedLine[]>([]);

  useEffect(() => {
    let cancelled = false;

    computeAlignedDiffAsync(deferredOldValue, deferredNewValue)
      .then((result) => {
        if (!cancelled) setRawAlignedLines(result);
      })
      .catch((error) => {
        log.error("[SplitDiff] Rust aligned diff error:", error);
        if (!cancelled) setRawAlignedLines([]);
      });

    return () => {
      cancelled = true;
    };
  }, [deferredOldValue, deferredNewValue]);

  // Apply collapsing if enabled
  const displayLines = useMemo(() => {
    if (!collapseUnchanged) {
      return rawAlignedLines;
    }
    return collapseSplitViewLines(rawAlignedLines, contextLines);
  }, [rawAlignedLines, collapseUnchanged, contextLines]);

  // Flatten display lines including expanded sections
  const alignedLines = useMemo(() => {
    const result: AlignedLine[] = [];
    displayLines.forEach((item, idx) => {
      if ("type" in item && item.type === "collapse") {
        if (expandedSections.has(idx)) {
          // Show expanded lines
          result.push(...item.collapsedLines);
        }
        // Skip collapsed sections in the flattened view
      } else {
        result.push(item as AlignedLine);
      }
    });
    return result;
  }, [displayLines, expandedSections]);

  // Calculate stats
  const stats: DiffStats = useMemo(() => {
    let additions = 0;
    let deletions = 0;
    alignedLines.forEach((line) => {
      if (line.newLine?.type === "add") additions++;
      if (line.oldLine?.type === "remove") deletions++;
    });
    return { additions, deletions };
  }, [alignedLines]);

  // Get changeable line indices separately for old (deletions) and new (additions)
  const changeableIndices: ChangeableIndices = useMemo(() => {
    const oldIndices: number[] = [];
    const newIndices: number[] = [];
    alignedLines.forEach((line) => {
      if (line.oldLine?.type === "remove") {
        oldIndices.push(line.index);
      }
      if (line.newLine?.type === "add") {
        newIndices.push(line.index);
      }
    });
    return {
      oldIndices,
      newIndices,
      allIndices: [...new Set([...oldIndices, ...newIndices])],
    };
  }, [alignedLines]);

  // Compute contiguous change ranges
  const changeRanges: ChangeRange[] = useMemo(() => {
    const ranges: ChangeRange[] = [];
    let currentRange: ChangeRange | null = null;

    alignedLines.forEach((line) => {
      const isChange =
        line.newLine?.type === "add" || line.oldLine?.type === "remove";

      if (isChange) {
        if (!currentRange) {
          // Start a new range
          currentRange = { startIndex: line.index, lineIndices: [line.index] };
        } else {
          // Continue the current range
          currentRange.lineIndices.push(line.index);
        }
      } else {
        // End current range if exists
        if (currentRange) {
          ranges.push(currentRange);
          currentRange = null;
        }
      }
    });

    // Don't forget the last range
    if (currentRange) {
      ranges.push(currentRange);
    }

    return ranges;
  }, [alignedLines]);

  // Map line index to its range
  const lineToRange = useMemo(() => {
    const map = new Map<number, ChangeRange>();
    changeRanges.forEach((range) => {
      range.lineIndices.forEach((idx) => {
        map.set(idx, range);
      });
    });
    return map;
  }, [changeRanges]);

  // Check if all changeable lines are selected (both old and new)
  const allSelected = useMemo(() => {
    const { oldIndices, newIndices } = changeableIndices;
    if (oldIndices.length === 0 && newIndices.length === 0) return false;
    const allOldSelected = oldIndices.every((idx: number) =>
      selectedOldLines.has(idx)
    );
    const allNewSelected = newIndices.every((idx: number) =>
      selectedNewLines.has(idx)
    );
    return allOldSelected && allNewSelected;
  }, [changeableIndices, selectedOldLines, selectedNewLines]);

  // Track previously known changeable lines to detect new ones
  const previousOldIndices = useRef<Set<number>>(new Set());
  const previousNewIndices = useRef<Set<number>>(new Set());

  // Auto-select all changes by default, and auto-select new changes when diff refreshes
  useEffect(() => {
    const { oldIndices, newIndices } = changeableIndices;
    if (!cherrypicking || (oldIndices.length === 0 && newIndices.length === 0))
      return;

    // First time initialization - select all
    if (!hasInitializedSelection.current) {
      hasInitializedSelection.current = true;
      previousOldIndices.current = new Set(oldIndices);
      previousNewIndices.current = new Set(newIndices);
      setSelectedOldLines(new Set(oldIndices));
      setSelectedNewLines(new Set(newIndices));
      onSelectionChange?.(new Set([...oldIndices, ...newIndices]));
      return;
    }

    // Check for new changeable lines that weren't in the previous set
    const newOldIndices = oldIndices.filter(
      (idx: number) => !previousOldIndices.current.has(idx)
    );
    const newNewIndices = newIndices.filter(
      (idx: number) => !previousNewIndices.current.has(idx)
    );

    if (newOldIndices.length > 0) {
      setSelectedOldLines((prev) => {
        const next = new Set(prev);
        newOldIndices.forEach((idx: number) => next.add(idx));
        return next;
      });
    }

    if (newNewIndices.length > 0) {
      setSelectedNewLines((prev) => {
        const next = new Set(prev);
        newNewIndices.forEach((idx: number) => next.add(idx));
        return next;
      });
    }

    // Update the tracked indices
    previousOldIndices.current = new Set(oldIndices);
    previousNewIndices.current = new Set(newIndices);
  }, [cherrypicking, changeableIndices, onSelectionChange]);

  // Toggle old (deletion) line selection
  const toggleOldSelection = useCallback((index: number) => {
    setSelectedOldLines((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // Toggle new (addition) line selection
  const toggleNewSelection = useCallback((index: number) => {
    setSelectedNewLines((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // Toggle entire range selection (both old and new)
  const toggleRangeSelection = useCallback(
    (range: ChangeRange) => {
      // Get old and new indices within this range
      const rangeOldIndices = range.lineIndices.filter((idx) => {
        const line = alignedLines.find((line) => line.index === idx);
        return line?.oldLine?.type === "remove";
      });
      const rangeNewIndices = range.lineIndices.filter((idx) => {
        const line = alignedLines.find((line) => line.index === idx);
        return line?.newLine?.type === "add";
      });

      // Check if all are selected
      const allOldInRange = rangeOldIndices.every((idx) =>
        selectedOldLines.has(idx)
      );
      const allNewInRange = rangeNewIndices.every((idx) =>
        selectedNewLines.has(idx)
      );
      const allSelectedInRange = allOldInRange && allNewInRange;

      if (allSelectedInRange) {
        // Deselect all in range
        setSelectedOldLines((prev) => {
          const next = new Set(prev);
          rangeOldIndices.forEach((idx) => next.delete(idx));
          return next;
        });
        setSelectedNewLines((prev) => {
          const next = new Set(prev);
          rangeNewIndices.forEach((idx) => next.delete(idx));
          return next;
        });
      } else {
        // Select all in range
        setSelectedOldLines((prev) => {
          const next = new Set(prev);
          rangeOldIndices.forEach((idx) => next.add(idx));
          return next;
        });
        setSelectedNewLines((prev) => {
          const next = new Set(prev);
          rangeNewIndices.forEach((idx) => next.add(idx));
          return next;
        });
      }
    },
    [alignedLines, selectedOldLines, selectedNewLines]
  );

  // Check if a range is fully selected
  const isRangeFullySelected = useCallback(
    (range: ChangeRange) => {
      const rangeOldIndices = range.lineIndices.filter((idx) => {
        const line = alignedLines.find((line) => line.index === idx);
        return line?.oldLine?.type === "remove";
      });
      const rangeNewIndices = range.lineIndices.filter((idx) => {
        const line = alignedLines.find((line) => line.index === idx);
        return line?.newLine?.type === "add";
      });
      const allOld = rangeOldIndices.every((idx) => selectedOldLines.has(idx));
      const allNew = rangeNewIndices.every((idx) => selectedNewLines.has(idx));
      return allOld && allNew;
    },
    [alignedLines, selectedOldLines, selectedNewLines]
  );

  // Check if a range is partially selected (some but not all)
  const isRangePartiallySelected = useCallback(
    (range: ChangeRange) => {
      const rangeOldIndices = range.lineIndices.filter((idx) => {
        const line = alignedLines.find((line) => line.index === idx);
        return line?.oldLine?.type === "remove";
      });
      const rangeNewIndices = range.lineIndices.filter((idx) => {
        const line = alignedLines.find((line) => line.index === idx);
        return line?.newLine?.type === "add";
      });
      const someOld = rangeOldIndices.some((idx) => selectedOldLines.has(idx));
      const someNew = rangeNewIndices.some((idx) => selectedNewLines.has(idx));
      const allOld = rangeOldIndices.every((idx) => selectedOldLines.has(idx));
      const allNew = rangeNewIndices.every((idx) => selectedNewLines.has(idx));
      // Partial if some are selected but not all
      return (someOld || someNew) && !(allOld && allNew);
    },
    [alignedLines, selectedOldLines, selectedNewLines]
  );

  // Toggle all changeable lines
  const toggleAllSelection = useCallback(() => {
    const { oldIndices, newIndices } = changeableIndices;
    if (allSelected) {
      // Deselect all
      setSelectedOldLines(new Set());
      setSelectedNewLines(new Set());
    } else {
      // Select all
      setSelectedOldLines(new Set(oldIndices));
      setSelectedNewLines(new Set(newIndices));
    }
  }, [allSelected, changeableIndices]);

  // Expand a collapsed section
  const handleExpand = useCallback((sectionIndex: number) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      next.add(sectionIndex);
      return next;
    });
  }, []);

  return {
    // State
    language,
    isPending,
    displayLines,
    alignedLines,
    stats,
    selectedOldLines,
    selectedNewLines,
    allSelected,
    expandedSections,

    // Computed values
    lineToRange,

    // Actions
    toggleOldSelection,
    toggleNewSelection,
    toggleRangeSelection,
    toggleAllSelection,
    handleExpand,
    isRangeFullySelected,
    isRangePartiallySelected,
  };
}
