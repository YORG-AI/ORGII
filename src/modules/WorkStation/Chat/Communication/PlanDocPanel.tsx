import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import { SessionReplayCodeMirrorViewer } from "@src/modules/WorkStation/CodeEditor/SessionReplay/CodePanel";

interface PlanDocPanelProps {
  content: string;
  planRevisionId?: string;
  statusLabel?: string;
  readyForReview?: boolean;
  /**
   * Absolute plan path resolved from the `create_plan` tool_result. `null`
   * when the tool is still streaming (result has not arrived yet) or when
   * extraction failed. CodeMirror still renders cleanly in that case —
   * language is hard-pinned to markdown because a plan doc is, by
   * definition, markdown; CodeMirror only needs the path for its filename
   * label, not for dispatch.
   */
  planPath: string | null;
  isPreviewMode: boolean;
  /** When set, render an edit textarea with the given value/onChange instead of the viewer. */
  editState?: {
    value: string;
    onChange: (v: string) => void;
  };
}

export const PlanDocPanel: React.FC<PlanDocPanelProps> = memo(
  ({
    content,
    planRevisionId,
    statusLabel,
    readyForReview = false,
    planPath,
    isPreviewMode,
    editState,
  }) => {
    const { t } = useTranslation("sessions");
    const hasContent = content.trim().length > 0;

    return (
      <div
        className="allow-select-deep flex h-full w-full flex-col overflow-hidden"
        data-testid="plan-doc-panel"
        data-plan-revision-id={planRevisionId ?? ""}
        data-plan-ready={readyForReview ? "true" : "false"}
      >
        {statusLabel ? (
          <div className="flex h-8 shrink-0 items-center border-b border-border-2 px-3">
            <span className="rounded-full bg-fill-2 px-2 py-0.5 text-[11px] font-medium text-text-3">
              {statusLabel}
            </span>
          </div>
        ) : null}
        <div className="code-viewer-scroll-container relative min-h-0 flex-1 overflow-hidden">
          {editState ? (
            <textarea
              data-testid="plan-doc-editor"
              className="scrollbar-overlay h-full w-full resize-none bg-bg-1 p-4 text-[13px] leading-relaxed text-text-1 outline-none"
              value={editState.value}
              onChange={(e) => editState.onChange(e.target.value)}
              spellCheck={false}
              autoFocus
            />
          ) : isPreviewMode ? (
            <div className="scrollbar-overlay h-full overflow-auto px-4 pt-4 pb-[120px]">
              {hasContent ? (
                <Markdown textContent={content} skipPreprocess />
              ) : (
                <div className="rounded-lg border border-dashed border-border-2 bg-fill-1 p-4 text-[13px] text-text-3">
                  {t("planDoc.emptyPlan")}
                </div>
              )}
            </div>
          ) : (
            <SessionReplayCodeMirrorViewer
              content={content}
              language="markdown"
              filePath={planPath ?? ""}
            />
          )}
        </div>
      </div>
    );
  }
);

PlanDocPanel.displayName = "PlanDocPanel";
