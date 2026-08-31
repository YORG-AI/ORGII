/**
 * TestResultsTab Configuration Hook
 *
 * Returns tab configuration for the Test Results panel.
 */
import { useMemo } from "react";

import { ICON_CONFIG } from "../config";
import TestResultsContent from "../content/TestResultsContent";
import type { TabAction, TabConfig } from "../types";

export interface TestResultsTabOptions {
  onResultClick?: (filePath: string, line?: number) => void;
  actions: TabAction[];
}

export function useTestResultsTabConfig({
  onResultClick,
  actions,
}: TestResultsTabOptions): TabConfig {
  const content = useMemo(
    () => (
      <TestResultsContent
        onResultClick={onResultClick}
        className="h-full w-full"
      />
    ),
    [onResultClick]
  );

  return {
    key: "test-results",
    icon: ICON_CONFIG.testResults,
    title: "Test Results",
    content,
    actions,
  };
}
