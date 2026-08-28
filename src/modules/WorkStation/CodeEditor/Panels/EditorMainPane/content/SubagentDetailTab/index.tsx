/**
 * SubagentDetailTab - Chat-like view of subagent activities and result
 *
 * Opened from the external-link icon on SubagentBlock cards.
 * Renders the subagent's tool calls as nested chat blocks via
 * `NestedActivityList` (same renderer as the inline chat-in-chat view),
 * with the final result displayed as markdown.
 */
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Markdown from "@src/components/MarkDown";
import { Placeholder } from "@src/components/Placeholder";
import { NestedActivityListForSession } from "@src/engines/ChatPanel/blocks/SubagentBlock/NestedActivityList";
import { ArrowRight01Icon, HugeiconsIcon, Tick01Icon } from "@src/icons";
import type { SubagentDetailTabData } from "@src/store/workstation/tabs/types";

// ============================================
// Helpers
// ============================================

function formatElapsedTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}

// ============================================
// Main Component
// ============================================

interface SubagentDetailTabProps {
  data: SubagentDetailTabData;
}

const SubagentDetailTab: React.FC<SubagentDetailTabProps> = memo(({ data }) => {
  const { t } = useTranslation("sessions");
  const {
    description,
    subagentType,
    resultContent,
    success,
    subagentSessionId,
    elapsedMs,
    prompt,
    errorMessage,
  } = data;

  const hasResult = Boolean(resultContent && resultContent.trim().length > 0);
  const hasPrompt = Boolean(prompt && prompt.trim().length > 0);
  const hasError = Boolean(errorMessage && errorMessage.trim().length > 0);

  const statusInfo = useMemo(() => {
    if (success) {
      return {
        icon: (
          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-green-600/80">
            <HugeiconsIcon
              icon={Tick01Icon}
              data-icon="check"
              size={12}
              strokeWidth={3}
              className="text-white"
            />
          </div>
        ),
        label: t("tools.subagentStatusCompleted"),
        className: "text-green-400",
      };
    }
    return {
      icon: (
        <div className="flex h-5 w-5 items-center justify-center rounded-full bg-danger-5">
          <span className="text-[10px] font-bold leading-none text-white">
            !
          </span>
        </div>
      ),
      label: t("tools.subagentStatusError"),
      className: "text-danger-5",
    };
  }, [success, t]);

  return (
    <div className="scrollbar-overlay flex h-full flex-col overflow-y-auto bg-bg-1">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-fill-3 px-6 py-4">
        <div className="flex items-center gap-3">
          {statusInfo.icon}
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-medium leading-snug text-text-1">
              {description || t("tools.subagentDefaultName")}
            </h2>
            <div className="mt-1 flex items-center gap-2 text-[12px] text-text-3">
              <span className={statusInfo.className}>{statusInfo.label}</span>
              {elapsedMs && (
                <>
                  <span className="text-text-3/40">·</span>
                  <span>{formatElapsedTime(elapsedMs)}</span>
                </>
              )}
              {subagentType && (
                <>
                  <span className="text-text-3/40">·</span>
                  <span>{subagentType}</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 px-6 py-4">
        {/* Prompt (pinned, read-only) */}
        {hasPrompt && (
          <div className="mb-6">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-3">
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={12}
              />
              <span>Prompt</span>
            </div>
            <div className="rounded-lg bg-fill-2 px-4 py-3 text-[13px] leading-relaxed text-text-2">
              <span className="whitespace-pre-wrap">{prompt}</span>
            </div>
          </div>
        )}

        {/* Activities feed (nested blocks from child session) */}
        {subagentSessionId && (
          <div className="mb-6">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-3">
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={12}
              />
              <span>Activities</span>
            </div>
            <div className="rounded-lg bg-fill-2 py-2">
              <NestedActivityListForSession
                subagentSessionId={subagentSessionId}
                interactive
              />
            </div>
          </div>
        )}

        {/* Error (failed / cancelled) */}
        {hasError && (
          <div className="mb-6">
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-danger-5">
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={12}
              />
              <span>Error</span>
            </div>
            <div className="rounded-lg border border-danger-5/30 bg-danger-5/5 px-4 py-3 text-[13px] leading-relaxed text-danger-5">
              <span className="whitespace-pre-wrap">{errorMessage}</span>
            </div>
          </div>
        )}

        {/* Result */}
        {hasResult && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[12px] font-medium text-text-3">
              <HugeiconsIcon
                icon={ArrowRight01Icon}
                data-icon="chevron-right"
                size={12}
              />
              <span>Result</span>
            </div>
            <div className="rounded-lg bg-fill-2 px-4 py-3 text-[13px] leading-relaxed text-text-2">
              <Markdown textContent={resultContent || ""} useChatCodeBlock />
            </div>
          </div>
        )}

        {/* Empty state */}
        {!hasPrompt && !subagentSessionId && !hasError && !hasResult && (
          <Placeholder
            variant="loading"
            placement="detail-panel"
            title={t("tools.runningSubagent")}
            fillParentHeight
          />
        )}
      </div>
    </div>
  );
});

SubagentDetailTab.displayName = "SubagentDetailTab";

export default SubagentDetailTab;
