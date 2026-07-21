import { Bot, Repeat, Terminal } from "lucide-react";
import React, { useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";

import TabPill from "@src/components/TabPill";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import { useWorkItemImageInsert } from "@src/hooks/project";
import {
  ProjectContentEditor,
  type ProjectContentEditorRef,
} from "@src/modules/ProjectManager/shared";
import {
  DetailPanelContainer,
  SessionTable,
  type SessionTableItem,
} from "@src/modules/shared/layouts/blocks";
import type { LinkedSession, WorkItemStatus } from "@src/types/core/workItem";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import AgentWorkflow from "../AgentWorkflow";
import { ROLE_I18N_KEYS, STATUS_I18N_KEYS } from "../AgentWorkflow/types";
import TodoChecklist from "../TodoChecklist";
import WorkItemContentStack from "../WorkItemContentStack";
import HistoryTab from "./HistoryTab";
import OutputTab from "./OutputTab";
import { useWorkItemContentState } from "./hooks/useWorkItemContentState";
import type { SessionTab, WorkItemContentProps } from "./types";

interface LinkedSessionsListProps {
  sessions: LinkedSession[];
  activeAgentSessionId?: string | null;
  onOpenSession?: (sessionId: string) => void;
}

const LINKED_SESSION_STATUS_COLOR: Record<LinkedSession["status"], string> = {
  running: "var(--color-primary-6)",
  completed: "var(--color-success-6)",
  failed: "var(--color-danger-6)",
  cancelled: "var(--color-warning-6)",
};

function getLinkedSessionTitle(session: LinkedSession): string {
  if (session.result_preview) return session.result_preview;
  if (session.sub_agent_name) return session.sub_agent_name;
  return session.session_id;
}

const LinkedSessionsList: React.FC<LinkedSessionsListProps> = ({
  sessions,
  activeAgentSessionId,
  onOpenSession,
}) => {
  const { t, i18n } = useTranslation(["projects", "common"]);
  const dateTimeLabelOptions = useMemo(
    () => ({
      todayLabel: t("common:relativeDate.today"),
      yesterdayLabel: t("common:relativeDate.yesterday"),
      locale: toIntlLocaleTag(i18n.resolvedLanguage),
    }),
    [i18n.resolvedLanguage, t]
  );
  const tableItems = useMemo<SessionTableItem[]>(() => {
    if (sessions.length === 0) {
      return [
        {
          id: "work-item-linked-sessions-empty",
          title: t("workItems.sessions.emptyOverview"),
          statusLabel: "—",
          disabled: true,
          testId: "work-item-linked-sessions-empty-row",
        },
      ];
    }

    return sessions.map((session) => {
      const roleLabelKey = ROLE_I18N_KEYS[session.agent_role];
      const statusLabelKey = STATUS_I18N_KEYS[session.status];
      const roleLabel = roleLabelKey
        ? t(roleLabelKey)
        : session.sub_agent_name || session.agent_role;
      const statusLabel = statusLabelKey ? t(statusLabelKey) : session.status;
      const agentIcon =
        session.session_type === "cli" ? (
          <Terminal size={14} strokeWidth={1.75} className="text-text-3" />
        ) : (
          <Bot size={14} strokeWidth={1.75} className="text-text-3" />
        );

      return {
        id: session.session_id,
        title: getLinkedSessionTitle(session),
        description:
          session.result_preview &&
          session.result_preview !== session.session_id
            ? session.session_id
            : undefined,
        statusLabel,
        statusColor: LINKED_SESSION_STATUS_COLOR[session.status],
        agentIcon,
        agentLabel: roleLabel,
        modelLabel: session.session_type,
        workspaceLabel: session.parent_session_id,
        workspaceTitle: session.parent_session_id,
        startedLabel: formatReplayDateLabel(session.started_at, {
          ...dateTimeLabelOptions,
          withSeconds: false,
          monthStyle: "short",
        }),
        lastUpdatedLabel: formatReplayDateLabel(
          session.completed_at ?? session.started_at,
          {
            ...dateTimeLabelOptions,
            withSeconds: false,
            monthStyle: "short",
          }
        ),
        active: session.session_id === activeAgentSessionId,
        testId: `work-item-linked-session-${session.session_id}`,
      };
    });
  }, [activeAgentSessionId, dateTimeLabelOptions, sessions, t]);

  return (
    <div data-testid="work-item-linked-sessions">
      <SessionTable
        items={tableItems}
        onSelect={(item) => onOpenSession?.(item.id)}
        maxHeight={360}
      />
    </div>
  );
};

const WorkItemContent: React.FC<WorkItemContentProps> = ({
  workItem,
  onUpdateWorkItem,
  onUpdateWorkItemImmediate,
  currentUser: currentUserProp,
  teamMembers = [],
  headerPath,
  headerProperties,
  titleVisible = false,
  repoPath,
  projectSlug,
  shortId,
  onStartAgent,
  isStartingAgent,
  onCancelAgent,
  onRetry,
  onAcceptAsIs,
  onCreateFollowUp,
  onOpenSession,
  onOpenFileDiff,
  onOpenFileAtLine,
  onReviewAllFiles,
  onRefreshWorkflow,
  activeAgentSessionId,
  activeAgentRole,
  isLockedByOther,
  lockHolderName,
  onCreatePr,
}) => {
  const { t } = useTranslation("projects");
  const editorRef = useRef<ProjectContentEditorRef>(null);

  const { handleImageInsert } = useWorkItemImageInsert({
    projectSlug: projectSlug ?? null,
    editorRef,
  });

  const {
    currentUser,
    activeSessionTab,
    setActiveSessionTab,
    commentText,
    setCommentText,
    isSubscribed,
    setIsSubscribed,
    isSubmittingComment,
    sessionTabItems,
    resolvedDescription,
    rawDescription,
    timelineEntries,
    formatRelativeTime,
    handleTitleChange,
    handleDescriptionChange,
    handleTodosChange,
    handleCommentSubmit,
    handleStartAgentAndOpenChat,
  } = useWorkItemContentState({
    workItem,
    onUpdateWorkItem,
    onUpdateWorkItemImmediate,
    currentUserProp,
    teamMembers,
    projectSlug,
    shortId,
    onStartAgent,
    onOpenSession,
    activeAgentSessionId,
  });

  const descriptionSection = (
    <>
      {workItem.routineSource && (
        <div
          className="mb-2 inline-flex items-center gap-1.5 rounded-full bg-fill-2 px-2 py-0.5 text-[11px] text-text-3"
          data-testid="work-item-routine-source-chip"
          title={workItem.routineSource.firedAt}
        >
          <Repeat size={11} className="shrink-0" />
          <span className="truncate">
            {t("workItems.fromRoutine", {
              name: workItem.routineSource.routineName,
            })}
          </span>
        </div>
      )}
      <ProjectContentEditor
        key={workItem.session_id}
        ref={editorRef}
        title={workItem.name || ""}
        onTitleChange={handleTitleChange}
        initialDescription={resolvedDescription ?? rawDescription}
        onDescriptionChange={handleDescriptionChange}
        onImageInsert={onUpdateWorkItem ? handleImageInsert : undefined}
        titleVisible={titleVisible}
        separatorVisible={false}
        descriptionPlaceholder={t("workItems.descriptionPlaceholder")}
        editable={!!onUpdateWorkItem}
        descriptionMaxHeight={600}
        descriptionClassName="no-bottom-border"
        repoPath={repoPath}
        className="w-full"
        dataTestId="work-item-content-editor"
      />
    </>
  );

  const todosSection = (
    <TodoChecklist
      todos={workItem.todos ?? []}
      onChange={handleTodosChange}
      disabled={!onUpdateWorkItem}
    />
  );

  const lowerSection = (
    <section data-testid="work-item-lower-tabs-section">
      <div className="mb-4 flex items-center justify-start">
        <TabPill
          tabs={sessionTabItems}
          activeTab={activeSessionTab}
          onChange={(key) => setActiveSessionTab(key as SessionTab)}
          variant="simple"
          fillWidth={false}
          size="large"
        />
      </div>

      {activeSessionTab === "session" && (
        <>
          <div className={DETAIL_PANEL_TOKENS.sectionGap}>
            <AgentWorkflow
              orchestratorState={workItem.orchestratorState}
              orchestratorConfig={workItem.orchestratorConfig}
              proofOfWork={workItem.proofOfWork}
              workItemStatus={
                workItem.workItemStatus ?? (workItem.status as WorkItemStatus)
              }
              executionLock={workItem.executionLock}
              linkedSessions={workItem.linkedSessions}
              onStartAgent={handleStartAgentAndOpenChat}
              isStartingAgent={isStartingAgent}
              onCancel={onCancelAgent}
              onRetry={onRetry}
              onAcceptAsIs={onAcceptAsIs}
              onCreateFollowUp={onCreateFollowUp}
              onOpenSession={onOpenSession}
              onOpenFileAtLine={onOpenFileAtLine}
              onRefresh={onRefreshWorkflow}
              activeAgentSessionId={activeAgentSessionId}
              activeAgentRole={activeAgentRole}
              isLockedByOther={isLockedByOther}
              lockHolderName={lockHolderName}
            />
          </div>
          <LinkedSessionsList
            sessions={workItem.linkedSessions ?? []}
            activeAgentSessionId={activeAgentSessionId}
            onOpenSession={onOpenSession}
          />
        </>
      )}

      {activeSessionTab === "output" && (
        <OutputTab
          workItem={workItem}
          repoPath={repoPath}
          onOpenFileDiff={onOpenFileDiff}
          onOpenFileAtLine={onOpenFileAtLine}
          onReviewAllFiles={onReviewAllFiles}
          onOpenSession={onOpenSession}
          onRetry={onRetry}
          onAcceptAsIs={onAcceptAsIs}
          onCreateFollowUp={onCreateFollowUp}
          onCancel={onCancelAgent}
          onCreatePr={onCreatePr}
        />
      )}

      {activeSessionTab === "history" && (
        <HistoryTab
          timelineEntries={timelineEntries}
          currentUser={currentUser}
          isSubscribed={isSubscribed}
          onToggleSubscribe={() => setIsSubscribed(!isSubscribed)}
          commentText={commentText}
          onCommentTextChange={setCommentText}
          onCommentSubmit={handleCommentSubmit}
          isSubmittingComment={isSubmittingComment}
          formatRelativeTime={formatRelativeTime}
        />
      )}
    </section>
  );

  return (
    <DetailPanelContainer className="relative">
      <WorkItemContentStack
        pathContent={headerPath}
        propertiesContent={headerProperties}
        descriptionContent={descriptionSection}
        todosContent={todosSection}
        lowerContent={lowerSection}
        scrollable
      />
    </DetailPanelContainer>
  );
};

export default WorkItemContent;
