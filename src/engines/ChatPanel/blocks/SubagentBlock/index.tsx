/**
 * SubagentBlock — session-in-session card for subagent tool calls.
 *
 * The nested subagent activity (events, todos, streaming reasoning) is
 * rendered by the Simulator panel to the right of the chat — this block
 * intentionally does NOT duplicate that timeline inline. The prompt is
 * always shown when available, with its own inline max-height + expand
 * control. The header itself is not collapsible.
 *
 * Visual states:
 *   1. **Running** — infinity icon, shimmer title, Stop button visible.
 *   2. **Success** — infinity icon, assignment prompt preview when available.
 *   3. **Failed / cancelled** — infinity icon, error body.
 */
import React, {
  memo,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import AnyIcon from "@src/components/AnyIcon";
import { ChatBubbleAvatar, ChatBubbleBody } from "@src/components/ChatBubble";
import { resolveAgentIcon } from "@src/config/agentIcons";
import type { ToolUsageMetadata } from "@src/engines/SessionCore/core/types";
import { createLogger } from "@src/hooks/logger";
import { Infinity01Icon, HugeiconsIcon, SquareIcon } from "@src/icons";

import ToolUsageBadge from "../ToolCallBlock/ToolUsageBadge";
import {
  EVENT_LOADING_SHIMMER_TEXT_CLASSES,
  EventNavigateIcon,
  SESSION_UI_TOKENS,
} from "../primitives";
import { InSimulatorReplayContext } from "../primitives/inSimulatorReplayContext";
import { SubagentPromptPreview, formatElapsedTime } from "./SubagentHelpers";

const log = createLogger("SubagentBlock");

// ============================================
// Types
// ============================================

export interface SubagentBlockProps {
  description: string;
  subagentType?: string;
  /**
   * Resolved display name of the delegated agent (e.g. "Explore"). Rendered
   * as the bubble's sender label `@{agentName}`. Falls back to a generic
   * "Subagent" label when absent.
   */
  agentName?: string;
  /**
   * Icon slug for the delegated agent's avatar. Falls back to the
   * delegation (infinity) mark when the agent has no resolved icon.
   */
  agentIconId?: string;
  resultContent?: string;
  resultSummary?: string;
  isLoading?: boolean;
  defaultCollapsed?: boolean;
  elapsedMs?: number;
  subagentSessionId?: string;
  prompt?: string;
  status?: "pending" | "running" | "success" | "failed" | "cancelled";
  success?: boolean;
  errorMessage?: string;
  eventId?: string;
  /** Called when the user clicks the navigate icon — locates the subagent
   *  cell in the right-side monitor panel. */
  onNavigate?: () => void;
  toolUsage?: ToolUsageMetadata;
}

// ============================================
// Main Component
// ============================================

const SubagentBlock: React.FC<SubagentBlockProps> = memo(
  ({
    description,
    agentName,
    agentIconId,
    isLoading = false,
    elapsedMs,
    subagentSessionId,
    prompt,
    status,
    success,
    errorMessage,
    onNavigate,
    toolUsage,
  }) => {
    const { t } = useTranslation("sessions");
    const { t: tCommon } = useTranslation();
    const inSimulatorReplay = useContext(InSimulatorReplayContext);

    const hasNestedSession = Boolean(subagentSessionId);
    const hasPrompt = Boolean(prompt && prompt.trim().length > 0);
    const hasErrorMessage = Boolean(
      errorMessage && errorMessage.trim().length > 0
    );
    // `success === false` alone is not a reliable failure signal: the Rust
    // extractor defaults `success` to false whenever the parent tool_call's
    // result is still empty (running, or the brief window between
    // displayStatus flipping to Completed and `recompute_extracted` seeing
    // the merged result). Only treat the run as failed when status is
    // explicitly terminal, or when the extractor also surfaced an
    // errorMessage (which it only populates on confirmed failure).
    const isFailure =
      status === "failed" ||
      status === "cancelled" ||
      (success === false && hasErrorMessage);

    const timingLabel = elapsedMs ? formatElapsedTime(elapsedMs) : undefined;

    // ── Stop button ──
    const [isStopping, setIsStopping] = useState(false);
    const isActive = status === "running" || status === "pending" || isLoading;
    const effectiveIsStopping = isStopping && isActive;
    const canStop = isActive && hasNestedSession;

    useEffect(() => {
      if (!isLoading) setIsStopping(false);
    }, [isLoading]);

    const handleStop = useCallback(
      async (event: React.MouseEvent) => {
        event.stopPropagation();
        if (!subagentSessionId || effectiveIsStopping) return;
        setIsStopping(true);
        try {
          const { CANCEL_REASON, cancelSession } =
            await import("@src/api/tauri/agent/session");
          await cancelSession(
            subagentSessionId,
            CANCEL_REASON.PROGRAMMATIC_SHUTDOWN
          );
        } catch (err) {
          log.error("Failed to cancel subagent:", err);
          setIsStopping(false);
        }
      },
      [subagentSessionId, effectiveIsStopping]
    );

    // ── Bubble content ──
    // Mirrors the Agent Team group-chat bubble: a localized title row aligns
    // with the avatar (elapsed time + controls on its right), and the delegated
    // agent reads as an "@mention" (primary-6) inside the neutral bubble below,
    // followed by the task headline and the assignment prompt as the body.
    const title = t("tools.assignedTaskToSubagent");
    const nameLabel = agentName?.trim() || t("tools.subagentDefaultName");
    const mention = `@${nameLabel}`;

    const AgentIcon = agentIconId
      ? resolveAgentIcon(agentIconId)
      : Infinity01Icon;
    const showNavigate = Boolean(onNavigate) && !inSimulatorReplay;

    const headerRight =
      toolUsage || canStop ? (
        <div className="flex items-center gap-2 pl-2">
          {toolUsage && <ToolUsageBadge usage={toolUsage} />}
          {canStop && (
            <button
              type="button"
              data-testid="subagent-card-stop-button"
              className="flex h-5 w-0 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full border-none bg-text-2 text-white transition-colors hover:bg-text-1 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50 group-hover/chat-block-header:w-5"
              onClick={handleStop}
              disabled={effectiveIsStopping}
              title={tCommon("common:actions.stop")}
              aria-label={tCommon("common:actions.stop")}
            >
              {effectiveIsStopping ? (
                <div className="h-2.5 w-2.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
              ) : (
                <HugeiconsIcon
                  icon={SquareIcon}
                  data-icon="square"
                  size={10}
                  fill="currentColor"
                  strokeWidth={0}
                />
              )}
            </button>
          )}
        </div>
      ) : undefined;

    return (
      <div
        className="group/chat-block-header flex gap-2.5"
        data-testid="subagent-bubble"
      >
        <div className="flex h-7 shrink-0 items-center">
          <ChatBubbleAvatar
            className="h-7 w-7 bg-fill-2"
            icon={
              <AnyIcon
                icon={AgentIcon}
                size={15}
                strokeWidth={1.75}
                className={isFailure ? "text-text-3" : "text-text-2"}
              />
            }
          />
        </div>
        <div className="min-w-0 max-w-[min(750px,100%)] flex-1">
          {/* Title row — aligns with the avatar */}
          <div className="flex h-7 items-center gap-2">
            <span
              className={`min-w-0 truncate font-medium ${isLoading ? EVENT_LOADING_SHIMMER_TEXT_CLASSES : isFailure ? "text-text-3" : "text-text-1"}`}
              title={title}
            >
              {title}
            </span>
            {timingLabel && !isLoading && (
              <span
                className={`shrink-0 ${SESSION_UI_TOKENS.FONT_SIZE_SM} text-text-3`}
              >
                {timingLabel}
              </span>
            )}
            {(headerRight || showNavigate) && (
              <div className="ml-auto flex shrink-0 items-center gap-1">
                {headerRight}
                {showNavigate && onNavigate && (
                  <EventNavigateIcon onClick={onNavigate} />
                )}
              </div>
            )}
          </div>

          <ChatBubbleBody
            variant="neutral"
            className="!rounded-2xl !px-3 !py-2"
          >
            <div className="break-words">
              <span
                className={`font-medium ${isLoading ? EVENT_LOADING_SHIMMER_TEXT_CLASSES : isFailure ? "text-text-3" : "text-primary-6"}`}
                title={mention}
              >
                {mention}
              </span>
              {description && (
                <span
                  className={`ml-1.5 ${isLoading ? EVENT_LOADING_SHIMMER_TEXT_CLASSES : isFailure ? "text-danger-5" : "text-text-1"}`}
                >
                  {description}
                </span>
              )}
            </div>

            {hasPrompt && (
              <div className="mt-1">
                <SubagentPromptPreview
                  prompt={prompt as string}
                  fadeFrom="from-fill-2"
                />
              </div>
            )}

            {isFailure && hasErrorMessage && (
              <div
                className={`mt-1 ${SESSION_UI_TOKENS.FONT_SIZE_SM} leading-relaxed text-danger-5`}
              >
                {errorMessage}
              </div>
            )}

            {isLoading && !hasPrompt && (
              <div
                className={`mt-1 ${SESSION_UI_TOKENS.FONT_SIZE_SM} ${EVENT_LOADING_SHIMMER_TEXT_CLASSES}`}
              >
                {t("tools.runningSubagent")}
              </div>
            )}
          </ChatBubbleBody>
        </div>
      </div>
    );
  }
);

SubagentBlock.displayName = "SubagentBlock";

export default SubagentBlock;
