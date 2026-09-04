/**
 * GitDiffViewer Component
 *
 * Unified diff viewer with integrated header and view mode switching
 * Combines file header, stats, view mode toggle, and diff display into one component
 */
import React, { useState } from "react";

import { Placeholder } from "@src/components/Placeholder";
import type { DiffViewMode } from "@src/types/git/types";

import { ModernSplitDiff } from "./ModernSplitDiff";
import { VirtualizedModernDiff } from "./VirtualizedModernDiff";

// ============================================
// Types
// ============================================

export type { DiffViewMode } from "@src/types/git/types";

export interface GitDiffViewerProps {
  /** Original/old content */
  oldValue: string | undefined;
  /** Modified/new content */
  newValue: string | undefined;
  /** File path for display and language detection */
  filePath: string;
  /** Is the file staged? */
  staged?: boolean;
  /** Loading state */
  loading?: boolean;
  /** Controlled view mode */
  viewMode?: DiffViewMode;
  /** Callback when view mode changes (for controlled mode) */
  onViewModeChange?: (mode: DiffViewMode) => void;
  /** Default view mode (for uncontrolled mode) */
  defaultViewMode?: DiffViewMode;
  /** Number of context lines around changes (unified view only) */
  contextLines?: number;
  /** Collapse unchanged regions (unified view only) */
  collapseUnchanged?: boolean;
  /** Read-only mode */
  readOnly?: boolean;
  /** Enable cherry-picking mode for selecting individual lines */
  cherrypicking?: boolean;
  /** Callback when selected lines change */
  onSelectionChange?: (selectedLines: Set<number>) => void;
  /** Initial selected lines */
  initialSelection?: Set<number>;
}

// ============================================
// Main Component
// ============================================

const GitDiffViewer: React.FC<GitDiffViewerProps> = ({
  oldValue,
  newValue,
  filePath,
  staged: _staged = false,
  loading = false,
  viewMode: controlledViewMode,
  onViewModeChange,
  defaultViewMode = "unified",
  contextLines = 3,
  collapseUnchanged = true,
  readOnly = true,
  cherrypicking = false,
  onSelectionChange,
  initialSelection,
}) => {
  const [internalViewMode, setInternalViewMode] =
    useState<DiffViewMode>(defaultViewMode);

  // Use controlled or uncontrolled mode
  const viewMode =
    controlledViewMode !== undefined ? controlledViewMode : internalViewMode;
  const _setViewMode = (mode: DiffViewMode) => {
    if (onViewModeChange) {
      onViewModeChange(mode);
    } else {
      setInternalViewMode(mode);
    }
  };

  const hasContent = oldValue !== undefined && newValue !== undefined;

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Diff Content */}
      {loading || !hasContent ? (
        // Loading state
        <Placeholder variant="loading" title="Loading diff..." />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {viewMode === "split" ? (
            // Split view
            <ModernSplitDiff
              oldValue={oldValue}
              newValue={newValue}
              filePath={filePath}
              height="100%"
              readOnly={readOnly}
              noWrapper={true}
              contextLines={contextLines}
              collapseUnchanged={collapseUnchanged}
              cherrypicking={cherrypicking}
              onSelectionChange={onSelectionChange}
              initialSelection={initialSelection}
            />
          ) : (
            // Unified view - using virtualized version for better performance
            <VirtualizedModernDiff
              oldValue={oldValue}
              newValue={newValue}
              filePath={filePath}
              height="100%"
              collapseUnchanged={collapseUnchanged}
              contextLines={contextLines}
              readOnly={readOnly}
              showFilePath={false}
              showStatsBar={false}
              noWrapper={true}
              cherrypicking={cherrypicking}
              onSelectionChange={onSelectionChange}
              initialSelection={initialSelection}
            />
          )}
        </div>
      )}
    </div>
  );
};

export default GitDiffViewer;
