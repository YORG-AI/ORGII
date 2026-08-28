/**
 * SubagentPromptToggle
 *
 * Info-button + popover injected into `SubagentChatPane`'s pagination
 * trailing slot. Clicking the button opens a small popover anchored
 * below it that renders the subagent's **original task prompt** — the
 * first user-source message of the session, parsed via
 * `parseTaskAssignedPrompt` when it matches the agent-org inbox-drain
 * format ("Task assigned by Coordinator: …"), otherwise rendered as
 * plain prompt text.
 *
 * This mirrors how agent-org task cards surface the assigned task
 * description on demand — the simulator cell already renders the live
 * chat, so the prompt itself is the only thing that's not otherwise
 * visible without scrolling back to turn 1.
 */
import { useAtomValue } from "jotai";
import React, { memo, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "@src/config/workstation/tokens";
import {
  type ParsedTaskAssignedPrompt,
  parseTaskAssignedPrompt,
} from "@src/engines/ChatPanel/ChatHistory/GroupChatView/parseTaskAssignedPrompt";
import UserMessageContent from "@src/engines/ChatPanel/ChatHistory/components/UserMessageContent";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { HugeiconsIcon, InformationCircleIcon } from "@src/icons";
import { getViewportSize } from "@src/util/ui/window/viewport";

const PROMPT_PANEL_WIDTH = 440;
const PROMPT_PANEL_MARGIN = 12;
const PROMPT_PANEL_MAX_HEIGHT = 360;

interface SubagentPromptToggleProps {
  sessionId: string;
}

interface ResolvedPrompt {
  parsed: ParsedTaskAssignedPrompt | null;
  rawText: string;
}

function resolvePromptFromSession(
  events: readonly SessionEvent[]
): ResolvedPrompt | null {
  for (const event of events) {
    if (event.source !== "user") continue;
    const text = event.displayText?.trim() ?? "";
    if (!text) continue;
    const parsed = parseTaskAssignedPrompt(text);
    return { parsed, rawText: text };
  }
  return null;
}

const SubagentPromptToggleComponent: React.FC<SubagentPromptToggleProps> = ({
  sessionId,
}) => {
  const { t } = useTranslation("sessions");
  const events = useAtomValue(chatEventsForSessionAtomFamily(sessionId));
  const prompt = useMemo(() => resolvePromptFromSession(events), [events]);
  const buttonRef = useRef<HTMLButtonElement>(null);

  const { isOpen, isPositioned, toggle, panelRef, panelPosition } =
    useDropdownEngine<HTMLButtonElement>({
      anchorRef: buttonRef,
      gap: 6,
      placement: "auto",
      align: "left",
    });

  const hasPrompt = prompt !== null;

  const label = t("simulator.subagentPane.viewTaskPrompt", {
    defaultValue: "View task prompt",
  });

  const panelStyle = useMemo<React.CSSProperties>(() => {
    const { width: viewportWidth } = getViewportSize();
    const width = Math.min(
      PROMPT_PANEL_WIDTH,
      Math.max(0, viewportWidth - PROMPT_PANEL_MARGIN * 2)
    );
    const maxLeft = viewportWidth - width - PROMPT_PANEL_MARGIN;
    const left = Math.min(
      Math.max(panelPosition.left, PROMPT_PANEL_MARGIN),
      Math.max(PROMPT_PANEL_MARGIN, maxLeft)
    );

    return {
      position: "fixed",
      top: panelPosition.top,
      left,
      bottom: panelPosition.bottom,
      width,
      maxHeight: PROMPT_PANEL_MAX_HEIGHT,
    };
  }, [panelPosition.bottom, panelPosition.left, panelPosition.top]);

  return (
    <>
      <Button
        ref={buttonRef}
        htmlType="button"
        variant="tertiary"
        size="small"
        iconOnly
        disabled={!hasPrompt}
        data-testid="subagent-task-prompt-toggle"
        aria-pressed={isOpen}
        className={isOpen ? "!bg-surface-hover !text-primary-6" : ""}
        onClick={toggle}
        title={label}
        aria-label={label}
        icon={
          <HugeiconsIcon
            icon={InformationCircleIcon}
            data-icon="info"
            size={16}
            strokeWidth={1.75}
          />
        }
      />

      {isOpen &&
        isPositioned &&
        hasPrompt &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            className={`z-50 flex min-w-[280px] flex-col overflow-hidden rounded-lg border border-border-2 shadow-lg ${EDITOR_TAB_CANVAS_BG_CLASS}`}
            style={panelStyle}
          >
            {prompt.parsed ? (
              <ParsedPromptPanel parsed={prompt.parsed} />
            ) : (
              <RawPromptPanel
                text={prompt.rawText}
                label={t("simulator.subagentPane.taskPromptTitle", {
                  defaultValue: "Task prompt",
                })}
              />
            )}
          </div>,
          document.body
        )}
    </>
  );
};

const ParsedPromptPanel: React.FC<{ parsed: ParsedTaskAssignedPrompt }> = ({
  parsed,
}) => {
  return (
    <>
      <div className="flex shrink-0 items-start gap-2 border-b border-border-2/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[12px] font-medium text-text-1">
            {parsed.subject}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-text-3">
            {parsed.assignedBy}
            {parsed.taskId ? ` · ${parsed.taskId}` : ""}
          </div>
        </div>
      </div>
      <div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px] leading-relaxed text-text-1">
        <UserMessageContent text={parsed.description} />
      </div>
    </>
  );
};

const RawPromptPanel: React.FC<{ text: string; label: string }> = ({
  text,
  label,
}) => {
  return (
    <>
      <div className="shrink-0 border-b border-border-2/60 px-3 py-1.5 text-[12px] font-medium text-text-1">
        {label}
      </div>
      <div className="scrollbar-overlay min-h-0 flex-1 overflow-y-auto px-3 py-2 text-[12px] leading-relaxed text-text-1">
        <UserMessageContent text={text} />
      </div>
    </>
  );
};

export const SubagentPromptToggle = memo(SubagentPromptToggleComponent);
SubagentPromptToggle.displayName = "SubagentPromptToggle";
