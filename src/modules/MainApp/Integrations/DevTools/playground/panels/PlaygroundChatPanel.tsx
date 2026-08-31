/**
 * PlaygroundChatPanel
 *
 * Renders event previews in a ChatPanel-like container with real InputArea.
 *
 * Converts SessionEvent[] → processChatItems() → OptimizedChatItem[] → ChatItemRenderer,
 * reusing the same pipeline as the main ChatHistory.
 */
import { arrayMove } from "@dnd-kit/sortable";
import { useAtomValue } from "jotai";
import React, { Suspense, lazy, useCallback, useMemo, useState } from "react";

import type { AgentOrgMemberIntervention } from "@src/api/tauri/agent";
import { ChatProvider } from "@src/contexts/workspace/ChatContext";
import { processChatItems } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline";
import type { OptimizedChatItem } from "@src/engines/ChatPanel/ChatHistory/chatItemPipeline/types";
import { ChatItemRenderer } from "@src/engines/ChatPanel/ChatHistory/renderers";
import { ModeSwitchCardBody } from "@src/engines/ChatPanel/InputArea/ModeSwitchCard/ModeSwitchCardBody";
import ActiveProcesses from "@src/engines/ChatPanel/InputArea/components/ActiveProcesses";
import AgentOrgInterventionPinBar from "@src/engines/ChatPanel/InputArea/components/AgentOrgInterventionPinBar";
import CollapsedInlineRow from "@src/engines/ChatPanel/InputArea/components/CollapsedInlineRow";
import CompactFileChanges from "@src/engines/ChatPanel/InputArea/components/CompactFileChanges";
import QueueEditModeCard from "@src/engines/ChatPanel/InputArea/components/QueueEditModeCard";
import QueuedMessages from "@src/engines/ChatPanel/InputArea/components/QueuedMessages";
import { useComposerSections } from "@src/engines/ChatPanel/InputArea/hooks/useComposerSections";
import { useQueueEditMode } from "@src/engines/ChatPanel/InputArea/hooks/useQueueEditMode";
import {
  ChatRetryStatusBar,
  GroupChatPausedBanner,
} from "@src/engines/ChatPanel/components/ChatStatusBanners";
import { stripMcpPrefix } from "@src/engines/SessionCore/core/interactiveTools";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import {
  MOCK_ACTIVE_PROCESSES,
  MOCK_FILE_CHANGES,
  MOCK_QUEUED_MESSAGES,
} from "@src/modules/MainApp/ToolPreview/mockData";
import {
  chatCodeFontSizeAtom,
  chatFontSizeAtom,
  chatLineHeightAtom,
} from "@src/store/config/configAtom";

import { ApprovalPreview } from "../previews/ApprovalPreview";
import { AskQuestionPreview } from "../previews/AskQuestionPreview";
import type { PlaygroundChatExtras } from "./PlaygroundLayout";

const LazyInputArea = lazy(() => import("@src/engines/ChatPanel/InputArea"));

// ============================================
// Static no-op handlers (stable references)
// ============================================

const NOOP = () => {};
const NOOP_MESSAGE_ACTION = (_messageId: string) => {};
const NOOP_SUBMIT = (_eventId: string, _answers: Record<string, string>) => {};
const MOCK_INTERVENTION: AgentOrgMemberIntervention = {
  orgRunId: "playground-org-run",
  memberId: "frontend-dev",
  agentId: "builtin:sde",
  sessionId: "agent-playground-member",
  status: "user_intervention",
  reason: "playground",
  enteredAt: "2026-05-31T00:00:00Z",
  lastUserActivityAt: "2026-05-31T00:00:00Z",
  resumeAfter: "2026-05-31T00:05:00Z",
  clearedAt: null,
};

function isInteractivePending(
  event: SessionEvent,
  canonicalName: string
): boolean {
  return (
    stripMcpPrefix(event.functionName ?? "") === canonicalName &&
    (event.displayStatus === "awaiting_user" ||
      event.displayStatus === "running" ||
      event.displayStatus === "pending")
  );
}

// ============================================
// Public component
// ============================================

interface PlaygroundChatPanelProps {
  events: SessionEvent[];
  chatExtras?: PlaygroundChatExtras;
  inputOnly?: boolean;
}

export function PlaygroundChatPanel({
  events,
  chatExtras,
  inputOnly = false,
}: PlaygroundChatPanelProps) {
  const chatFontSize = useAtomValue(chatFontSizeAtom);
  const chatCodeFontSize = useAtomValue(chatCodeFontSizeAtom);
  const chatLineHeight = useAtomValue(chatLineHeightAtom);

  const [demoQueue, setDemoQueue] = useState(MOCK_QUEUED_MESSAGES);
  const handleDemoReorder = useCallback((from: number, to: number) => {
    setDemoQueue((prev) => arrayMove(prev, from, to));
  }, []);

  const handleCommitDemoEdit = useCallback(
    (messageId: string, content: string) => {
      setDemoQueue((prev) =>
        prev.map((msg) =>
          msg.id === messageId
            ? { ...msg, content, displayContent: content }
            : msg
        )
      );
    },
    []
  );
  const queueEditProps = useQueueEditMode({
    onCommit: handleCommitDemoEdit,
    onCommitSendNow: NOOP_MESSAGE_ACTION,
  });

  const effectiveQueueCount = chatExtras?.showQueuedMessages
    ? demoQueue.length
    : 0;

  const demoProcesses = chatExtras?.showTerminalProcesses
    ? MOCK_ACTIVE_PROCESSES
    : [];

  const optimizedItems = useMemo(() => {
    const { items } = processChatItems(events);
    return items;
  }, [events]);

  const pendingAskUser = useMemo(
    () =>
      events.find((evt) => isInteractivePending(evt, "ask_user_questions")) ??
      null,
    [events]
  );

  const pendingModeSwitch = useMemo(
    () =>
      events.find((evt) => isInteractivePending(evt, "suggest_mode_switch")) ??
      null,
    [events]
  );
  const showModeSwitchPreview =
    pendingModeSwitch !== null || !!chatExtras?.showModeSwitch;
  const modeSwitchTargetMode =
    (pendingModeSwitch?.args?.target_mode as string | undefined) ?? "plan";
  const modeSwitchReason =
    (pendingModeSwitch?.args?.reason as string | undefined) ??
    "Plan mode is a better fit for this next step.";

  const pendingApproval = useMemo(
    () =>
      events.find((evt) => isInteractivePending(evt, "ask_user_permissions")) ??
      null,
    [events]
  );

  const {
    questionCollapsed,
    permissionCollapsed,
    modeSwitchCollapsed,
    collapseQuestion,
    collapsePermission,
    collapseModeSwitch,
    queueExpanded,
    processExpanded,
    toggleQueue,
    toggleProcess,
    hasAny,
    inlineSections,
    setProcessVisibleCount,
    setFileChangeStats,
  } = useComposerSections({
    queueCount: effectiveQueueCount,
    hasQuestion: !!pendingAskUser,
    hasPermission: !!pendingApproval,
    hasModeSwitch: showModeSwitchPreview,
    onFilesExpand: NOOP,
  });

  const handleEditUserMessage = useCallback(
    (_chatItem: OptimizedChatItem, _newText: string) => {},
    []
  );

  const chatStyleVars = useMemo(
    () =>
      ({
        fontSize: `${chatFontSize}px`,
        lineHeight: chatLineHeight ?? 1.6,
        "--chat-font-size": `${chatFontSize}px`,
        "--chat-code-font-size": `${chatCodeFontSize ?? 13}px`,
        "--chat-line-height": chatLineHeight ?? 1.6,
      }) as React.CSSProperties,
    [chatFontSize, chatCodeFontSize, chatLineHeight]
  );

  const interventionBottomContent = chatExtras?.showInterventionBanner ? (
    <AgentOrgInterventionPinBar
      intervention={MOCK_INTERVENTION}
      memberName="Frontend Dev"
      error={null}
      returning={false}
      onReturnToWork={async () => true}
    />
  ) : null;

  const pausedBottomContent = chatExtras?.showPausedBanner ? (
    <GroupChatPausedBanner
      onResume={NOOP}
      testId="playground-agent-org-group-chat-paused-banner"
      resumeButtonTestId="playground-agent-org-group-chat-resume-button"
    />
  ) : null;

  const retryStatusItems =
    chatExtras?.retryKinds?.map((retryKind) => ({
      kind: retryKind,
      attempt: 2,
      maxAttempts: 5,
    })) ?? [];
  const hasHistoryContent = optimizedItems.length > 0;

  return (
    <div className="tool-event-preview-shell tool-event-preview-shell--chat">
      <div className="tool-event-preview-shell__content tool-event-preview-shell__content--chat">
        {/* Events area — wp__chat__history class activates the scoped SCSS rules from ChatHistory/index.scss */}
        <div
          className="wp__chat__history flex-1 overflow-auto px-3 py-4"
          style={chatStyleVars}
        >
          {hasHistoryContent && !inputOnly ? (
            <div className="flex flex-col gap-3">
              {optimizedItems.map((item, index) => (
                <ChatItemRenderer
                  key={item.chunk_id || `playground-${index}`}
                  chatItem={item}
                  index={index}
                  isWpGeneWorking={false}
                  isExploring={false}
                  onSubmit={NOOP_SUBMIT}
                  onSkip={NOOP}
                  onEditUserMessage={handleEditUserMessage}
                />
              ))}
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-text-3">
              No events to display
            </div>
          )}
        </div>

        {/* All stacked sections + InputArea (mirrors real ChatView layout) */}
        <ChatProvider>
          <div className="flex w-full flex-shrink-0 flex-col items-center px-2 py-2">
            <div className="flex w-full max-w-[800px] flex-col gap-1.5">
              {/* Primary cards — collapse to pill when chevron clicked */}
              {pendingAskUser && (
                <AskQuestionPreview
                  event={pendingAskUser}
                  collapsed={questionCollapsed}
                  onCollapse={collapseQuestion}
                />
              )}
              {pendingApproval && (
                <ApprovalPreview
                  event={pendingApproval}
                  collapsed={permissionCollapsed}
                  onCollapse={collapsePermission}
                />
              )}

              {/* Expanded section cards */}
              {queueExpanded && chatExtras?.showQueuedMessages && (
                <QueuedMessages
                  messages={demoQueue}
                  onCancel={NOOP_MESSAGE_ACTION}
                  onSendNow={NOOP_MESSAGE_ACTION}
                  onReorder={handleDemoReorder}
                  onToggle={toggleQueue}
                />
              )}
              {processExpanded && (
                <ActiveProcesses
                  initialProcesses={demoProcesses}
                  onToggle={toggleProcess}
                  onVisibleCountChange={setProcessVisibleCount}
                />
              )}
              {/* Always-mounted hidden instances for count tracking */}
              {!processExpanded && (
                <ActiveProcesses
                  initialProcesses={demoProcesses}
                  onToggle={toggleProcess}
                  onVisibleCountChange={setProcessVisibleCount}
                  hidden
                />
              )}
              {chatExtras?.showFileReview && (
                <CompactFileChanges
                  initialData={MOCK_FILE_CHANGES}
                  onVisibleStatsChange={setFileChangeStats}
                />
              )}

              <QueueEditModeCard />

              <Suspense fallback={null}>
                <LazyInputArea
                  topRowPills={
                    hasAny ? (
                      <CollapsedInlineRow sections={inlineSections} />
                    ) : null
                  }
                  statusBanners={
                    <>
                      {showModeSwitchPreview && !modeSwitchCollapsed && (
                        <ModeSwitchCardBody
                          targetMode={modeSwitchTargetMode}
                          reason={modeSwitchReason}
                          onSwitch={() => {}}
                          onSkip={() => {}}
                          collapsed={false}
                          onCollapse={collapseModeSwitch}
                        />
                      )}
                      {interventionBottomContent}
                      <ChatRetryStatusBar items={retryStatusItems} />
                      {pausedBottomContent}
                    </>
                  }
                  {...queueEditProps}
                />
              </Suspense>
            </div>
          </div>
        </ChatProvider>
      </div>
    </div>
  );
}

export default PlaygroundChatPanel;
