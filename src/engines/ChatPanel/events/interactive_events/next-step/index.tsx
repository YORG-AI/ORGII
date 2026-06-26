/**
 * NextStepEvent — renders `suggest_next_steps` tool calls as clickable cards.
 *
 * States:
 * - Running: shimmer text "Generating suggestions for next steps"
 * - Completed: header + row of clickable step cards
 * - Failed: hidden (returns null)
 *
 * When the user clicks a card, it sends the step's `command` as the next
 * user message via SessionService. Cards become disabled after selection.
 */
import { useAtomValue } from "jotai";
import { ArrowUp, Check } from "lucide-react";
import React, { memo, useCallback, useMemo, useRef, useState } from "react";

import { INPUT_AREA } from "@src/config/inputAreaTokens";
import { getToolIcon } from "@src/config/toolIcons";
import {
  EventBlockHeader,
  EventBlockHeaderIcon,
  EventBlockHeaderTitle,
} from "@src/engines/ChatPanel/blocks/primitives";
import { useUserIntentSubmit } from "@src/engines/ChatPanel/hooks/useWorkspaceChat/useUserIntentSubmit";
import { eventsAtom } from "@src/engines/SessionCore/core/atoms";
import {
  type RawEventInput,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import { useLifecycleLabels } from "@src/engines/SessionCore/rendering/registry";
import { createLogger } from "@src/hooks/logger";
import { isSessionActiveAtom } from "@src/store/session/cliSessionStatusAtom";
import { activeSessionIdAtom } from "@src/store/session/viewAtom";

const log = createLogger("NextStepEvent");

// ============================================
// Types
// ============================================

export interface NextStepEventProps extends RawEventInput {}

interface StepProposal {
  title: string;
  command: string;
}

// ============================================
// Data extraction
// ============================================

function extractSteps(result: Record<string, unknown>): StepProposal[] {
  const raw = result.content ?? result.steps ?? result.output;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed as StepProposal[];
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw as StepProposal[];
  return [];
}

// ============================================
// Step Card
// ============================================

const StepCard: React.FC<{
  step: StepProposal;
  disabled: boolean;
  selected: boolean;
  onSelect: () => void;
  index: number;
}> = memo(({ step, disabled, selected, onSelect, index }) => {
  const isInteractive = !disabled && !selected;

  return (
    <button
      type="button"
      className={[
        "group/next-step-row relative flex w-full items-center gap-3",
        INPUT_AREA.borderRadiusClass,
        "chat-block-title border px-3 py-2.5 text-left",
        "transition-all duration-200 ease-out",
        selected
          ? "cursor-default border-success-6/30 bg-success-6/5"
          : disabled
            ? "cursor-not-allowed border-border-1 bg-fill-1/50 opacity-50"
            : "cursor-pointer border-border-2 bg-fill-2/80 hover:border-primary-6/40 hover:bg-fill-2 hover:shadow-[0_2px_12px_-4px_color-mix(in_srgb,var(--color-primary-6)_20%,transparent)] active:scale-[0.995]",
      ].join(" ")}
      style={{
        animationDelay: `${index * 60}ms`,
      }}
      onClick={isInteractive ? onSelect : undefined}
      disabled={disabled}
    >
      {/* Index label */}
      <span
        className={[
          "chat-block-xs flex h-5 w-5 shrink-0 items-center justify-center rounded-md font-semibold tabular-nums",
          "transition-colors duration-200",
          selected
            ? "bg-success-6/15 text-success-6"
            : disabled
              ? "bg-fill-3 text-text-2"
              : "bg-fill-3 text-text-1 group-hover/next-step-row:bg-primary-6/10 group-hover/next-step-row:text-primary-6",
        ].join(" ")}
      >
        {index + 1}
      </span>

      <span
        className={[
          "min-w-0 flex-1 truncate",
          selected ? "text-text-1" : "text-text-1",
        ].join(" ")}
      >
        {step.title}
      </span>

      {/* Trailing indicator */}
      {selected ? (
        <span
          aria-hidden="true"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-success-6 text-white"
        >
          <Check size={11} strokeWidth={2.5} />
        </span>
      ) : isInteractive ? (
        <span
          aria-hidden="true"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary-6 text-white opacity-0 transition-opacity duration-150 group-hover/next-step-row:opacity-100"
        >
          <ArrowUp size={11} strokeWidth={2.25} />
        </span>
      ) : null}
    </button>
  );
});
StepCard.displayName = "StepCard";

// ============================================
// Chat Variant
// ============================================

const ChatVariant: React.FC<{
  steps: StepProposal[];
  isLoading: boolean;
  isFailed: boolean;
  eventId?: string;
}> = ({ steps, isLoading, isFailed, eventId }) => {
  const labels = useLifecycleLabels("suggest_next_steps", undefined, {
    count: steps.length,
  });

  const sessionId = useAtomValue(activeSessionIdAtom);
  const isSessionActive = useAtomValue(isSessionActiveAtom);
  const events = useAtomValue(eventsAtom);

  const submitUserIntent = useUserIntentSubmit({
    getSessionId: () => sessionId,
  });

  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const pendingRef = useRef(false);

  const toolIcon = getToolIcon("suggest_next_steps", {
    size: 14,
    className: "text-text-2",
  });

  // Cards stay interactive as long as the user has not sent a new message
  // after this event. Turn summary replay events (displayVariant "summary")
  // contain the original user prompt but are NOT new user input — skip them.
  // If the event ID is missing or not found (e.g. historical sessions with
  // reloaded event IDs), default to allowing interaction.
  const isLastEvent = useMemo(() => {
    if (!eventId) return true;
    let foundThisEvent = false;
    for (let idx = 0; idx < events.length; idx++) {
      const evt = events[idx];
      if (evt.id === eventId) {
        foundThisEvent = true;
        continue;
      }
      if (
        foundThisEvent &&
        evt.source === "user" &&
        evt.displayVariant !== "summary"
      ) {
        return false;
      }
    }
    return true;
  }, [events, eventId]);

  // Preview mode: no real agent session is active (DevTools playground,
  // storybook-style previews, etc.). Render cards as enabled-looking but
  // clicks are no-ops so the preview doesn't look broken/disabled.
  const isPreviewMode = sessionId == null;

  const canInteract =
    isPreviewMode || (isLastEvent && !isSessionActive && selectedIdx === null);

  const handleSelect = useCallback(
    async (idx: number) => {
      if (!canInteract || pendingRef.current) return;
      const step = steps[idx];
      if (!step) return;
      if (isPreviewMode || sessionId == null) return;

      pendingRef.current = true;
      setSelectedIdx(idx);

      void (async () => {
        try {
          await submitUserIntent({
            sessionId,
            displayContent: step.command,
            source: "interactive-event",
          });
        } catch (err) {
          log.error("[NextStepEvent] send failed:", err);
          setSelectedIdx(null);
        } finally {
          pendingRef.current = false;
        }
      })();
    },
    [canInteract, isPreviewMode, steps, sessionId, submitUserIntent]
  );

  if (isLoading) {
    return (
      <EventBlockHeader isCollapsed withHover={false}>
        <EventBlockHeaderIcon icon={toolIcon} isLoading />
        <EventBlockHeaderTitle isLoading>
          {labels.running}
        </EventBlockHeaderTitle>
      </EventBlockHeader>
    );
  }

  if (isFailed) return null;

  if (steps.length === 0) return null;

  return (
    <div
      className="w-full max-w-full overflow-hidden rounded-xl border border-border-1 bg-event-block transition-all duration-200"
      data-tool-call-event-id={eventId}
      data-tool-call-name="suggest_next_steps"
    >
      {/* Header row */}
      <div className="flex items-center gap-2 border-b border-border-1/60 px-3 py-2.5">
        <EventBlockHeaderIcon
          icon={toolIcon}
          isCollapsed={false}
          isHeaderHovered={false}
          hasContent={false}
        />
        <span className="chat-block-title font-medium text-text-2">
          {labels.done}
        </span>
      </div>

      {/* Step cards */}
      <div className="flex flex-col gap-1.5 p-2.5">
        {steps.map((step, idx) => (
          <StepCard
            key={idx}
            step={step}
            disabled={!canInteract}
            selected={selectedIdx === idx}
            onSelect={() => handleSelect(idx)}
            index={idx}
          />
        ))}
      </div>
    </div>
  );
};

// ============================================
// Main Component
// ============================================

export const NextStepEvent: React.FC<NextStepEventProps> = (props) => {
  const normalizedProps = useNormalizedEventProps(props, "suggest_next_steps");

  if (!normalizedProps) return null;

  const isLoading =
    normalizedProps.status === "running" &&
    normalizedProps.showActiveEventPainting === true;
  const isFailed = normalizedProps.status === "failed";
  const steps = extractSteps(normalizedProps.result ?? {});

  return (
    <ChatVariant
      steps={steps}
      isLoading={isLoading}
      isFailed={isFailed}
      eventId={normalizedProps.eventId}
    />
  );
};

NextStepEvent.displayName = "NextStepEvent";

export default NextStepEvent;
