/**
 * ProblemsTab Configuration Hook
 *
 * Returns tab configuration for the Problems panel.
 */
import { useMemo } from "react";

import { ICON_CONFIG } from "../config";
import ProblemsContent from "../content/ProblemsContent";
import type { Diagnostic } from "../content/ProblemsContent/types";
import type { TabAction, TabConfig } from "../types";

/** Count badge for tab pill - matches Source Control (primary.6) */
function ProblemsCountBadge({ count }: { count: number }) {
  return (
    <span className="flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-primary-6 px-1.5 text-[11px] font-medium text-white">
      {count}
    </span>
  );
}

export interface ProblemsTabOptions {
  diagnostics: Diagnostic[];
  onDiagnosticClick: (diagnostic: Diagnostic) => void;
  onClearAll: () => void;
  collapsedFiles?: Set<string>;
  onToggleFileGroup?: (filePath: string) => void;
  actions: TabAction[];
  isScanning?: boolean;
}

export function useProblemsTabConfig({
  diagnostics,
  onDiagnosticClick,
  onClearAll,
  collapsedFiles,
  onToggleFileGroup,
  actions,
  isScanning,
}: ProblemsTabOptions): TabConfig {
  const content = useMemo(
    () => (
      <ProblemsContent
        diagnostics={diagnostics}
        onDiagnosticClick={onDiagnosticClick}
        onClearAll={onClearAll}
        collapsedFiles={collapsedFiles}
        onToggleFileGroup={onToggleFileGroup}
        isScanning={isScanning}
        className="h-full w-full"
      />
    ),
    [
      diagnostics,
      onDiagnosticClick,
      onClearAll,
      collapsedFiles,
      onToggleFileGroup,
      isScanning,
    ]
  );

  // Combined count (errors + warnings) like VS Code
  const errorCount = diagnostics.filter(
    (diag) => diag.severity === "error"
  ).length;
  const warningCount = diagnostics.filter(
    (diag) => diag.severity === "warning"
  ).length;
  const combinedCount = errorCount + warningCount;

  const badge =
    combinedCount > 0 ? (
      <ProblemsCountBadge count={combinedCount} />
    ) : undefined;

  return {
    key: "problems",
    icon: ICON_CONFIG.problems,
    title: "Problems",
    content,
    actions,
    badge,
  };
}
