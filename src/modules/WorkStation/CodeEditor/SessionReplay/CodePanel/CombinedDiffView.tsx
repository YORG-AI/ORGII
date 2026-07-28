/**
 * Combined diff view for multiple edits on the same file in session replay.
 */
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import DiffStatsBadge from "@src/components/DiffStatsBadge";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import { VirtualizedModernDiff } from "@src/features/CodeViewer/VirtualizedModernDiff";

import { shouldTrustDiffStartLines } from "../converters/fileConverter";
import { resolveFileOperationPayload } from "../resolveFilePayload";
import type { FileOperationEntry } from "../types";
import { getEditStartLine } from "./editUtils";

const ChangeStats: React.FC<{
  linesAdded?: number;
  linesRemoved?: number;
}> = memo(({ linesAdded = 0, linesRemoved = 0 }) => {
  if (linesAdded === 0 && linesRemoved === 0) return null;

  return (
    <DiffStatsBadge
      additions={linesAdded}
      deletions={linesRemoved}
      variant="plain"
      size="xs"
      className="ml-auto"
    />
  );
});

ChangeStats.displayName = "ChangeStats";

/** Single edit section with collapsible content */
const EditSection: React.FC<{
  op: FileOperationEntry;
  idx: number;
  startLine: number;
  filePath: string;
  defaultExpanded: boolean;
}> = memo(({ op, idx, startLine, filePath, defaultExpanded }) => {
  const { t } = useTranslation("sessions");
  const [isCollapsed, setIsCollapsed] = useState(!defaultExpanded);

  const payload = useMemo(() => {
    if (isCollapsed) return null;
    return resolveFileOperationPayload(op);
  }, [isCollapsed, op]);
  const showLineNumbers = shouldTrustDiffStartLines(op.event);
  const hasContent =
    payload !== null &&
    (payload.oldContent !== undefined || payload.newContent !== undefined);

  const toggleCollapse = useCallback(() => {
    setIsCollapsed((prev) => !prev);
  }, []);

  return (
    <div className="flex flex-col">
      <button
        onClick={toggleCollapse}
        className={`sticky top-0 z-10 flex h-10 w-full cursor-pointer items-center gap-2 border-t border-border-2 px-3 text-[11px] hover:bg-fill-2 ${EDITOR_TAB_CANVAS_BG_CLASS}`}
      >
        {isCollapsed ? (
          <ChevronsUpDown size={14} className="shrink-0 text-text-3" />
        ) : (
          <ChevronsDownUp size={14} className="shrink-0 text-text-3" />
        )}
        <span className="font-medium text-text-2">
          {t("simulator.replay.ide.codePanel.editHeader", {
            index: `#${idx + 1}`,
          })}
          {startLine > 0 && (
            <span className="ml-1.5 text-text-4">
              {t("simulator.replay.ide.codePanel.startingAtLine", {
                line: startLine,
              })}
            </span>
          )}
        </span>
        <ChangeStats
          linesAdded={op.linesAdded}
          linesRemoved={op.linesRemoved}
        />
      </button>

      {!isCollapsed && (
        <>
          {hasContent ? (
            <VirtualizedModernDiff
              oldValue={payload.oldContent || ""}
              newValue={payload.newContent || ""}
              filePath={filePath}
              height="auto"
              oldStartLine={payload.oldStartLine}
              newStartLine={payload.newStartLine}
              showLineNumbers={showLineNumbers}
              contextLines={3}
              collapseUnchanged={true}
              showFilePath={false}
              showStatsBar={false}
              noWrapper={true}
              internalScroll={false}
            />
          ) : (
            <div className="px-4 py-2 text-[13px] text-success-6">
              {t("simulator.replay.ide.codePanel.fileEditedSuccess")}
            </div>
          )}
        </>
      )}
    </div>
  );
});

EditSection.displayName = "EditSection";

export const CombinedDiffView: React.FC<{
  operations: FileOperationEntry[];
  filePath: string;
}> = memo(({ operations, filePath }) => {
  const { t } = useTranslation("sessions");
  const activeEditRef = useRef<HTMLDivElement | null>(null);
  const sortedOps = useMemo(() => {
    return [...operations].sort((opA, opB) => {
      const lineA = getEditStartLine(opA);
      const lineB = getEditStartLine(opB);
      return lineA - lineB;
    });
  }, [operations]);

  const activeEditIndex = useMemo(() => {
    const currentIndex = sortedOps.findIndex((op) => op.isCurrent);
    return currentIndex >= 0 ? currentIndex : sortedOps.length - 1;
  }, [sortedOps]);

  const activeEditKey = sortedOps[activeEditIndex]?.eventId ?? "";
  const [expandedEarlierEditKey, setExpandedEarlierEditKey] = useState<
    string | null
  >(null);
  const showEarlierEdits = expandedEarlierEditKey === activeEditKey;

  useEffect(() => {
    const element = activeEditRef.current;
    const scrollContainer = element?.closest<HTMLElement>(
      ".code-viewer-scroll-container"
    );
    if (!element || !scrollContainer) return;

    const frameId = requestAnimationFrame(() => {
      scrollContainer.scrollTop = 0;
    });

    return () => cancelAnimationFrame(frameId);
  }, [activeEditKey]);

  const opsWithMeta = useMemo(() => {
    return sortedOps.map((op) => ({
      op,
      startLine: getEditStartLine(op),
    }));
  }, [sortedOps]);

  const earlierEditCount = Math.max(0, activeEditIndex);

  const handleLoadEarlierEdits = useCallback(() => {
    setExpandedEarlierEditKey(activeEditKey);
  }, [activeEditKey]);

  return (
    <div className="flex flex-col gap-0">
      {earlierEditCount > 0 && !showEarlierEdits && (
        <div className="flex w-full justify-center py-1.5">
          <Button
            htmlType="button"
            variant="tertiary"
            size="small"
            icon={<ChevronsUpDown size={14} />}
            onClick={handleLoadEarlierEdits}
          >
            {t("simulator.replay.ide.codePanel.loadEarlierEdits", {
              count: earlierEditCount,
            })}
          </Button>
        </div>
      )}
      {opsWithMeta.map(({ op, startLine }, idx) => {
        const isActiveEdit = idx === activeEditIndex;
        if (idx < activeEditIndex && !showEarlierEdits) return null;
        return (
          <div key={op.eventId} ref={isActiveEdit ? activeEditRef : undefined}>
            <EditSection
              op={op}
              idx={idx}
              startLine={startLine}
              filePath={filePath}
              defaultExpanded={isActiveEdit}
            />
          </div>
        );
      })}
    </div>
  );
});

CombinedDiffView.displayName = "CombinedDiffView";
