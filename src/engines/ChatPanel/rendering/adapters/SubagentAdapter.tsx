/**
 * SubagentAdapter — renders the full SubagentBlock for delegated-agent events.
 *
 * The pre-start "assigning" phase (no `subagentSessionId` yet, status still
 * `running`) is handled at the RecipeRenderer level: the Rust tool registry
 * declares action `"assign"` with `ChatBlock::TitleOnly`, so RecipeRenderer
 * routes to TitleOnlyAdapter automatically ("Briefing subagent…"). Under
 * normal operation, by the time this adapter renders, the event has
 * `action: "delegate"` and a `subagentSessionId`.
 *
 * Terminal failures can still reach here without a session id (e.g. a
 * planner refused the prompt before spawn). In that case the underlying
 * `SubagentBlock` falls back to showing the pinned prompt + error text as
 * its expandable payload.
 */
import { useAtomValue, useSetAtom } from "jotai";
import React, { useCallback, useMemo } from "react";

import { formatAgentType } from "@src/assets/providers";
import { navigateToEventAtom } from "@src/engines/SessionCore/core/atoms/actions";
import { chatEventsForSessionAtomFamily } from "@src/engines/SessionCore/derived/sessionScopedChatEvents";
import type { UniversalEventProps } from "@src/engines/SessionCore/rendering/types/universalProps";
import { sessionByIdAtom } from "@src/store/session/sessionAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import {
  focusedSubagentCellAtom,
  stationModeAtom,
  subagentPanelRevealRequestAtom,
} from "@src/store/ui/simulatorAtom";

import SubagentBlock from "../../blocks/SubagentBlock";
import { resolveSubagentPresentation } from "./subagentPresentation";
import {
  extractSubagentPromptFromChildEvents,
  firstSubagentAssignmentPrompt,
} from "./subagentPrompt";

const EMPTY_SUBAGENT_SESSION_ID = "__no-subagent-session__";

function extractSubagentData(props: UniversalEventProps) {
  const { args, result } = props;

  const fallbackErrorMessage =
    typeof result.error_message === "string"
      ? (result.error_message as string)
      : typeof result.error === "string"
        ? (result.error as string)
        : typeof result.message === "string" && result.success === false
          ? (result.message as string)
          : undefined;

  if (props.rustExtracted?.kind === "subagent") {
    const sub = props.rustExtracted;
    return {
      description: sub.description,
      subagentType: sub.subagentType,
      resultContent: sub.resultContent,
      resultSummary: sub.resultSummary,
      subagentSessionId: sub.subagentSessionId as string | undefined,
      elapsedMs: sub.elapsedMs,
      success: sub.success,
      errorMessage: sub.errorMessage ?? fallbackErrorMessage,
      prompt: firstSubagentAssignmentPrompt(
        sub.prompt,
        args.prompt,
        args.instructions,
        args.task
      ),
    };
  }

  const description =
    (args.description as string) || (args.task as string) || "";
  const subagentType =
    (args.subagent_type as string) || (args.type as string) || "";

  const resultContent =
    (result.content as string) || (result.output as string) || "";
  const resultSummary =
    typeof result.summary === "string" ? result.summary : undefined;

  const elapsedMs =
    typeof args.elapsedMs === "number" ? args.elapsedMs : undefined;

  const subagentSessionId =
    typeof args.subagentSessionId === "string"
      ? args.subagentSessionId
      : undefined;

  const prompt = firstSubagentAssignmentPrompt(
    args.prompt,
    args.instructions,
    args.task
  );

  const success =
    typeof result.success === "boolean" ? (result.success as boolean) : true;

  return {
    description,
    subagentType,
    resultContent,
    resultSummary,
    subagentSessionId,
    elapsedMs,
    success,
    errorMessage: fallbackErrorMessage,
    prompt,
  };
}

export const SubagentAdapter: React.FC<UniversalEventProps> = (props) => {
  const data = extractSubagentData(props);
  const childEvents = useAtomValue(
    chatEventsForSessionAtomFamily(
      data.subagentSessionId ?? EMPTY_SUBAGENT_SESSION_ID
    )
  );
  const childPrompt = useMemo(
    () => extractSubagentPromptFromChildEvents(childEvents),
    [childEvents]
  );
  const prompt = data.prompt ?? childPrompt;
  const hasPrompt = Boolean(prompt && prompt.trim().length > 0);
  const isAwaitingPrompt =
    Boolean(data.subagentSessionId) && !hasPrompt && childEvents.length === 0;

  // Native agents prefer their child-session display name. Imported Codex
  // sessions instead prefer the nickname parsed from thread_spawn because
  // their child-session display name is the assignment prompt, not an identity.
  const subagentSession = useAtomValue(
    sessionByIdAtom(data.subagentSessionId ?? EMPTY_SUBAGENT_SESSION_ID)
  );
  const presentation = resolveSubagentPresentation({
    sessionId: data.subagentSessionId,
    hasCodexThreadIdentity: typeof props.args.codexAgentThreadId === "string",
    parsedAgentName: data.subagentType
      ? formatAgentType(data.subagentType)
      : undefined,
    sessionAgentName: subagentSession?.agentDisplayName,
    description: data.description,
    prompt,
  });
  const agentIconId = subagentSession?.agentIconId;

  const setFocusedCell = useSetAtom(focusedSubagentCellAtom);
  const setPanelReveal = useSetAtom(subagentPanelRevealRequestAtom);
  const setChatPanelMaximized = useSetAtom(chatPanelMaximizedAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const navigateToEvent = useSetAtom(navigateToEventAtom);
  const handleNavigate = useCallback(() => {
    if (!data.subagentSessionId) return;
    // Seek the main replay cursor back to this subagent's delegate event so
    // the cursor lands inside the subagent's [startedAtMs, endedAtMs] clip
    // window. Without this, a subagent that already finished has retired its
    // monitor cell (the cursor sits past endedAtMs), so focusing the cell or
    // bumping the reveal counter has nothing to act on. navigateToEventAtom
    // also flips replayMode to "replay" (free-browse), pausing tail-follow at
    // that moment. The cell then re-materialises and focus/reveal take effect.
    navigateToEvent(props.eventId);
    setStationMode("agent-station");
    setChatPanelMaximized(false);
    setFocusedCell(data.subagentSessionId);
    setPanelReveal((prev) => prev + 1);
  }, [
    data.subagentSessionId,
    props.eventId,
    navigateToEvent,
    setChatPanelMaximized,
    setFocusedCell,
    setPanelReveal,
    setStationMode,
  ]);

  return (
    <div data-tool-call-event-id={props.eventId} data-tool-call-name="agent">
      <SubagentBlock
        description={presentation.description}
        subagentType={data.subagentType}
        agentName={presentation.agentName}
        agentIconId={agentIconId}
        resultContent={data.resultContent}
        resultSummary={data.resultSummary}
        isLoading={
          isAwaitingPrompt ||
          (props.status === "running" && props.showActiveEventPainting === true)
        }
        defaultCollapsed={true}
        elapsedMs={data.elapsedMs}
        subagentSessionId={data.subagentSessionId}
        prompt={prompt}
        status={props.status}
        success={data.success}
        errorMessage={data.errorMessage}
        eventId={props.eventId}
        onNavigate={data.subagentSessionId ? handleNavigate : undefined}
        toolUsage={props.toolUsage}
      />
    </div>
  );
};

SubagentAdapter.displayName = "SubagentAdapter";
