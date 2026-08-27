/**
 * TestResultsContent Component
 *
 * Bottom panel showing test results with detailed failure info.
 * Similar to VS Code's Test Results panel.
 */
import { useAtomValue } from "jotai";
import {
  AlertCircle,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  XCircle,
} from "lucide-react";
import React, { memo, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { useScrollToBottom } from "@src/hooks/ui/effects";
import {
  PLACEHOLDER_TOKENS,
  Placeholder,
} from "@src/modules/shared/layouts/blocks";
import {
  failedTestsAtom,
  lastRunSummaryAtom,
  testCountsAtom,
} from "@src/store/workstation/codeEditor/testRunner";
import type { TestResult } from "@src/types/testing";

// ============================================
// Types
// ============================================

export interface TestResultsContentProps {
  onResultClick?: (filePath: string, line?: number) => void;
  className?: string;
}

// ============================================
// Sub-Components
// ============================================

interface TestResultItemProps {
  result: TestResult;
  onClick?: () => void;
}

const TestResultItem: React.FC<TestResultItemProps> = memo(
  ({ result, onClick }) => {
    const [expanded, setExpanded] = useState(true);
    const hasDetails =
      result.errorMessage || result.stackTrace || result.expected;

    return (
      <div className="border-b border-border-2 last:border-b-0">
        {/* Header row */}
        <div
          className="flex cursor-pointer items-center gap-2 px-3 py-2 hover:bg-fill-1"
          onClick={() => {
            if (hasDetails) {
              setExpanded(!expanded);
            }
            onClick?.();
          }}
        >
          {/* Expand/collapse */}
          {hasDetails ? (
            <span className="text-text-3">
              {expanded ? (
                <ChevronDown size={14} />
              ) : (
                <ChevronRight size={14} />
              )}
            </span>
          ) : (
            <span className="w-[14px]" />
          )}

          {/* Status icon */}
          <XCircle size={14} className="shrink-0 text-danger-6" />

          {/* Test name */}
          <span className="min-w-0 flex-1 truncate text-[12px] text-text-1">
            {result.testId}
          </span>

          {/* File path */}
          {result.filePath && (
            <span className="shrink-0 text-[11px] text-text-3">
              {result.filePath.split("/").pop()}
              {result.line && `:${result.line}`}
            </span>
          )}

          {/* Duration */}
          {result.durationMs !== undefined && (
            <span className="shrink-0 text-[10px] text-text-4">
              {result.durationMs}ms
            </span>
          )}
        </div>

        {/* Details (expanded) */}
        {hasDetails && expanded && (
          <div className="border-t border-border-1 px-4 py-3">
            {/* Error message */}
            {result.errorMessage && (
              <div className="mb-2">
                <div className="mb-1 text-[10px] font-medium uppercase text-text-3">
                  Error
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap text-[11px] text-danger-6">
                  {result.errorMessage}
                </pre>
              </div>
            )}

            {/* Expected vs Actual */}
            {(result.expected || result.actual) && (
              <div className="mb-2 grid grid-cols-2 gap-3">
                {result.expected && (
                  <div>
                    <div className="mb-1 text-[10px] font-medium uppercase text-text-3">
                      Expected
                    </div>
                    <pre className="overflow-x-auto rounded bg-success-1 px-2 py-1 text-[11px] text-success-6">
                      {result.expected}
                    </pre>
                  </div>
                )}
                {result.actual && (
                  <div>
                    <div className="mb-1 text-[10px] font-medium uppercase text-text-3">
                      Actual
                    </div>
                    <pre className="overflow-x-auto rounded bg-danger-1 px-2 py-1 text-[11px] text-danger-6">
                      {result.actual}
                    </pre>
                  </div>
                )}
              </div>
            )}

            {/* Stack trace */}
            {result.stackTrace && (
              <div>
                <div className="mb-1 text-[10px] font-medium uppercase text-text-3">
                  Stack Trace
                </div>
                <pre className="max-h-[150px] overflow-auto whitespace-pre-wrap text-[10px] text-text-3">
                  {result.stackTrace}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }
);

TestResultItem.displayName = "TestResultItem";

// ============================================
// Main Component
// ============================================

export const TestResultsContent: React.FC<TestResultsContentProps> = memo(
  ({ onResultClick, className = "" }) => {
    const { t } = useTranslation();
    const failedTests = useAtomValue(failedTestsAtom);
    const summary = useAtomValue(lastRunSummaryAtom);
    const counts = useAtomValue(testCountsAtom);
    const resultsRef = useRef<HTMLDivElement>(null);

    // Auto-scroll to bottom when new test results arrive (VS Code-style)
    useScrollToBottom({
      containerRef: resultsRef,
      dependencies: [failedTests.length, summary?.startedAt],
      forceScroll: true, // Always scroll to show latest results
    });

    const handleResultClick = useCallback(
      (result: TestResult) => {
        if (result.filePath && onResultClick) {
          onResultClick(result.filePath, result.line);
        }
      },
      [onResultClick]
    );

    // No results yet
    if (!summary) {
      return (
        <Placeholder
          variant="empty"
          title={t("placeholders.runTestsToSeeResults")}
          className={className}
        />
      );
    }

    return (
      <div className={`flex h-full flex-col ${className}`}>
        {/* Summary header */}
        <div className="flex items-center gap-3 border-b border-border-2 px-3 py-2">
          <div className="flex items-center gap-2 text-[12px]">
            {counts.passed > 0 && (
              <span className="flex items-center gap-1 text-success-6">
                <Check size={14} />
                {counts.passed} passed
              </span>
            )}
            {counts.failed > 0 && (
              <span className="flex items-center gap-1 text-danger-6">
                <AlertCircle size={14} />
                {counts.failed} failed
              </span>
            )}
          </div>

          <div className="flex-1" />

          <span className="flex items-center gap-1 text-[11px] text-text-3">
            <Clock size={12} />
            {summary.durationMs}ms
          </span>
        </div>

        {/* Results list */}
        <div ref={resultsRef} className="min-h-0 flex-1 overflow-auto">
          {failedTests.length === 0 ? (
            <Placeholder
              variant="empty"
              title={t("placeholders.allTestsPassed")}
              icon={
                <Check
                  size={PLACEHOLDER_TOKENS.iconSize}
                  className="text-success-6"
                />
              }
            />
          ) : (
            failedTests.map((result) => (
              <TestResultItem
                key={result.testId}
                result={result}
                onClick={() => handleResultClick(result)}
              />
            ))
          )}
        </div>
      </div>
    );
  }
);

TestResultsContent.displayName = "TestResultsContent";

export default TestResultsContent;
