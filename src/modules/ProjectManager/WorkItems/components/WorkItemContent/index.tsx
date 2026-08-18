import { useAtomValue } from "jotai";
import { Bot, Pencil, Repeat, RotateCcw, Terminal } from "lucide-react";
import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type WorkItemHandoff,
  type WorkItemOriginSession,
  projectApi,
} from "@src/api/http/project";
import Avatar from "@src/components/Avatar";
import TabPill from "@src/components/TabPill";
import { useWorkItemImageInsert } from "@src/hooks/project";
import { builtInAgentsAtom } from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import {
  ProjectContentEditor,
  type ProjectContentEditorRef,
} from "@src/modules/ProjectManager/shared";
import { IssueTimelineItems } from "@src/modules/WorkStation/CodeEditor/Panels/EditorPrimarySidebar/content/IssuesContent/IssueTimelineItems";
import {
  ActivityHeaderActionButton,
  ConnectedTimelineItem,
  MarkdownContent,
  TimelineCard,
  TimelineCardHeader,
  TimelineStack,
} from "@src/modules/shared/components/ActivityTimeline";
import MarkdownTextareaEditor, {
  type MarkdownEditorMode,
} from "@src/modules/shared/components/MarkdownTextareaEditor";
import MarkdownEditorModeSwitch from "@src/modules/shared/components/MarkdownTextareaEditor/ModeSwitch";
import {
  formatTokensShort,
  formatUsd,
} from "@src/modules/shared/dataSource/usageFormat";
import {
  DetailPanelContainer,
  PanelFooter,
  ScrollTrailTarget,
  SessionTable,
  type SessionTableItem,
} from "@src/modules/shared/layouts/blocks";
import { type LinkedSession, WORK_ITEM_STATUS } from "@src/types/core/workItem";
import {
  formatReplayDateLabel,
  toIntlLocaleTag,
} from "@src/util/data/formatters/date";

import { ROLE_I18N_KEYS, STATUS_I18N_KEYS } from "../AgentWorkflow/types";
import TodoChecklist from "../TodoChecklist";
import WorkItemContentStack from "../WorkItemContentStack";
import WorkItemSubItems, { useWorkItemFamily } from "../WorkItemSubItems";
import {
  WorkItemThreadLayout,
  type WorkItemThreadView,
  WorkItemThreadViewAction,
} from "../WorkItemThread";
import CustomPropertiesSection from "./CustomPropertiesSection";
import GitHubIssueComposer from "./GitHubIssueComposer";
import HistoryTab from "./HistoryTab";
import OutputTab from "./OutputTab";
import ThreadTodoChecklist from "./ThreadTodoChecklist";
import WorkItemHandoffNotice from "./WorkItemHandoffNotice";
import WorkItemRunUsageSummary from "./WorkItemRunUsageSummary";
import { normalizeLegacyEscapedMarkdown } from "./descriptionMarkdown";
import { retryFailedLinkedSession } from "./discussionCommentForward";
import { useGitHubIssueTimeline } from "./hooks/useGitHubIssueTimeline";
import { useWorkItemContentState } from "./hooks/useWorkItemContentState";
import { resolveWorkItemContentSectionPolicy } from "./presentation";
import type { SessionTab, WorkItemContentProps } from "./types";

interface LinkedSessionsListProps {
  sessions: LinkedSession[];
  originSession?: WorkItemOriginSession;
  shortId?: string | null;
  projectSlug?: string | null;
  orgId?: string | null;
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
  originSession,
  shortId,
  projectSlug,
  orgId,
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
    if (sessions.length === 0 && !originSession) {
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

    const executionItems = sessions.map((session) => {
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
        tokensLabel:
          session.total_tokens > 0
            ? formatTokensShort(session.total_tokens)
            : undefined,
        tokensValue:
          session.total_tokens > 0 ? session.total_tokens : undefined,
        active: session.session_id === activeAgentSessionId,
        testId: `work-item-linked-session-${session.session_id}`,
        rowAction:
          session.status === "failed" && shortId ? (
            <button
              type="button"
              className="flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
              onClick={() => {
                retryFailedLinkedSession({
                  projectSlug,
                  orgId,
                  shortId,
                  sessionId: session.session_id,
                });
                onOpenSession?.(session.session_id);
              }}
              aria-label={t("workItems.sessions.retry", {
                defaultValue: "Retry",
              })}
              data-testid={`work-item-session-retry-${session.session_id}`}
            >
              <RotateCcw size={12} />
              {t("workItems.sessions.retry", { defaultValue: "Retry" })}
            </button>
          ) : undefined,
      };
    });
    if (
      !originSession ||
      sessions.some(
        (session) => session.session_id === originSession.session_id
      )
    ) {
      return executionItems;
    }
    return [
      {
        id: originSession.session_id,
        title: t("workItems.sessions.originTitle", {
          defaultValue: "Creation session",
        }),
        description: originSession.session_id,
        statusLabel: t("workItems.sessions.originStatus", {
          defaultValue: "Created this item",
        }),
        statusColor: "var(--color-primary-6)",
        agentIcon:
          originSession.session_type === "cli" ? (
            <Terminal size={14} strokeWidth={1.75} className="text-text-3" />
          ) : (
            <Bot size={14} strokeWidth={1.75} className="text-text-3" />
          ),
        agentLabel: originSession.actor_id.replace(/^agent:/, ""),
        modelLabel: originSession.session_type,
        startedLabel: formatReplayDateLabel(originSession.captured_at, {
          ...dateTimeLabelOptions,
          withSeconds: false,
          monthStyle: "short",
        }),
        lastUpdatedLabel: formatReplayDateLabel(originSession.captured_at, {
          ...dateTimeLabelOptions,
          withSeconds: false,
          monthStyle: "short",
        }),
        active: originSession.session_id === activeAgentSessionId,
        disabled: originSession.provider !== "org2",
        testId: `work-item-origin-session-${originSession.session_id}`,
      },
      ...executionItems,
    ];
  }, [
    activeAgentSessionId,
    dateTimeLabelOptions,
    onOpenSession,
    originSession,
    orgId,
    projectSlug,
    sessions,
    shortId,
    t,
  ]);

  const totalTokens = sessions.reduce(
    (sum, session) => sum + (session.total_tokens || 0),
    0
  );
  const totalCost = sessions.reduce(
    (sum, session) => sum + (session.cost_usd || 0),
    0
  );

  return (
    <div data-testid="work-item-linked-sessions">
      {sessions.length > 0 && (
        <div
          className="mb-1 flex items-center gap-3 px-1 text-[11px] text-text-4"
          data-testid="work-item-usage-summary"
        >
          <span>
            {t("workItems.sessions.runsCount", {
              defaultValue: "{{count}} runs",
              count: sessions.length,
            })}
          </span>
          {totalTokens > 0 && (
            <span>{formatTokensShort(totalTokens)} tokens</span>
          )}
          {totalCost > 0 && <span>{formatUsd(totalCost, 2)}</span>}
        </div>
      )}
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
  presentation = "default",
  onUpdateWorkItem,
  onUpdateWorkItemImmediate,
  currentUser: currentUserProp,
  teamMembers = [],
  availableAgents = [],
  availableOrgs = [],
  headerPath,
  headerProperties,
  titleVisible = false,
  repoPath,
  projectSlug,
  shortId,
  githubIssueTimeline,
  githubIssueInteraction,
  orgId,
  onOpenSubItem,
  onOpenSession,
  onOpenFileDiff,
  onOpenFileAtLine,
  onReviewAllFiles,
  onRefreshWorkflow,
  onTransitionHandoff,
  activeAgentSessionId,
  onCreatePr,
}) => {
  const { t } = useTranslation(["projects", "common"]);
  const editorRef = useRef<ProjectContentEditorRef>(null);
  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const mentionAgents = useMemo(
    () => [...builtInAgents, ...availableAgents],
    [builtInAgents, availableAgents]
  );

  const { handleImageInsert } = useWorkItemImageInsert({
    projectSlug: projectSlug ?? null,
    editorRef,
  });

  const subItemFamily = useWorkItemFamily(
    shortId ?? workItem.shortId ?? "",
    projectSlug,
    orgId
  );

  const {
    currentUser,
    currentUserMemberIds,
    activeSessionTab,
    setActiveSessionTab,
    commentText,
    setCommentText,
    replyToCommentId,
    setReplyToCommentId,
    mentionRefs,
    setMentionRefs,
    isSubscribed,
    handleToggleSubscription,
    isSubmittingComment,
    triggerPreview,
    sessionTabItems,
    resolvedDescription,
    rawDescription,
    timelineEntries,
    handleTitleChange,
    handleDescriptionChange,
    handleTodosChange,
    handleCommentSubmit,
    handleResolveDiscussionThread,
    handleReopenDiscussionThread,
  } = useWorkItemContentState({
    workItem,
    onUpdateWorkItem,
    onUpdateWorkItemImmediate,
    currentUserProp,
    teamMembers,
    availableAgents: mentionAgents,
    availableOrgs,
    projectSlug,
    shortId,
    orgId,
  });

  const creatorName =
    workItem.createdBy?.name ||
    teamMembers?.find((member) => member.id === workItem.user_id)?.name ||
    workItem.user_id ||
    t("workItems.activity.system");
  const normalizedRawDescription =
    normalizeLegacyEscapedMarkdown(rawDescription);
  const displayedDescription = normalizeLegacyEscapedMarkdown(
    resolvedDescription ?? rawDescription
  );
  const displayStatus = workItem.workItemStatus ?? workItem.status;
  const isGitHubWorkItem =
    displayStatus === WORK_ITEM_STATUS.GITHUB_OPEN ||
    displayStatus === WORK_ITEM_STATUS.GITHUB_CLOSED;
  const canEditDescription = isGitHubWorkItem
    ? Boolean(githubIssueInteraction?.canEditBody)
    : Boolean(onUpdateWorkItem);
  const loadedGitHubTimeline = useGitHubIssueTimeline({
    enabled: isGitHubWorkItem && !githubIssueTimeline,
    repoPath,
    shortId: shortId ?? workItem.shortId,
  });
  const githubTimeline =
    githubIssueTimeline?.items ?? loadedGitHubTimeline.timeline;
  const githubTimelineLoading =
    githubIssueTimeline?.loading ?? loadedGitHubTimeline.timelineLoading;
  const [descriptionDraftState, setDescriptionDraftState] = useState<{
    workItemId: string;
    base: string;
    value: string;
  } | null>(null);
  const [descriptionEditWorkItemId, setDescriptionEditWorkItemId] = useState<
    string | null
  >(null);
  const [descriptionSaveErrorWorkItemId, setDescriptionSaveErrorWorkItemId] =
    useState<string | null>(null);
  const [descriptionEditorMode, setDescriptionEditorMode] =
    useState<MarkdownEditorMode>("write");
  const [threadViewSelection, setThreadViewSelection] = useState<{
    workItemId: string;
    view: WorkItemThreadView;
  }>({
    workItemId: workItem.session_id,
    view: "overview",
  });
  const currentDescriptionDraft =
    descriptionDraftState?.workItemId === workItem.session_id
      ? descriptionDraftState
      : null;
  const descriptionHasChanges = Boolean(
    currentDescriptionDraft &&
    currentDescriptionDraft.value !== currentDescriptionDraft.base
  );
  const descriptionDraft =
    currentDescriptionDraft && descriptionHasChanges
      ? currentDescriptionDraft.value
      : displayedDescription;
  const sectionPolicy = resolveWorkItemContentSectionPolicy(
    presentation,
    Boolean(workItem.proofOfWork)
  );
  const isThread = presentation === "thread";
  const activeThreadView =
    !isGitHubWorkItem && threadViewSelection.workItemId === workItem.session_id
      ? threadViewSelection.view
      : "overview";
  const isEditingThreadDescription =
    isThread && descriptionEditWorkItemId === workItem.session_id;
  const [handoffOverride, setHandoffOverride] = useState<{
    workItemId: string;
    value: WorkItemHandoff;
  } | null>(null);
  const [respondingHandoff, setRespondingHandoff] = useState<
    "accept" | "return" | null
  >(null);
  const [handoffError, setHandoffError] = useState<string | null>(null);
  const handoff =
    handoffOverride?.workItemId === workItem.session_id &&
    handoffOverride.value.id === workItem.handoff?.id
      ? handoffOverride.value
      : workItem.handoff;
  const canRespondToHandoff = Boolean(
    handoff &&
    shortId &&
    (onTransitionHandoff || projectSlug) &&
    currentUserMemberIds.has(handoff.recipientMemberId) &&
    handoff.status === "pending"
  );
  const handoffRecipientName = handoff
    ? teamMembers.find((member) => member.id === handoff.recipientMemberId)
        ?.name
    : undefined;
  const handoffResponseUnavailableReason =
    handoff?.status === "pending" && currentUser.id === "system"
      ? t("common:teamInbox.handoff.identityUnavailable")
      : undefined;

  const respondToHandoff = (action: "accept" | "return", note?: string) => {
    if (
      !handoff ||
      !shortId ||
      (!onTransitionHandoff && !projectSlug) ||
      respondingHandoff ||
      !currentUserMemberIds.has(handoff.recipientMemberId)
    ) {
      return;
    }
    setRespondingHandoff(action);
    setHandoffError(null);
    const transition = {
      handoffId: handoff.id,
      action,
      actor: {
        id: handoff.recipientMemberId,
        name: handoffRecipientName || handoff.recipientName || currentUser.name,
      },
      note,
    } as const;
    const request = onTransitionHandoff
      ? onTransitionHandoff(transition)
      : projectApi.transitionWorkItemHandoff(projectSlug!, shortId, transition);
    void request
      .then((result) => {
        const nextHandoff =
          "frontmatter" in result ? result.frontmatter.handoff : result.handoff;
        if (nextHandoff) {
          setHandoffOverride({
            workItemId: workItem.session_id,
            value: nextHandoff,
          });
        }
        onRefreshWorkflow?.();
      })
      .catch(() => {
        setHandoffError(t("common:teamInbox.handoff.responseError"));
      })
      .finally(() => {
        setRespondingHandoff(null);
      });
  };
  const handoffNotice = handoff ? (
    <WorkItemHandoffNotice
      handoff={handoff}
      canRespond={canRespondToHandoff}
      error={handoffError}
      unavailableReason={handoffResponseUnavailableReason}
      responding={respondingHandoff}
      onAccept={() => respondToHandoff("accept")}
      onReturn={(reason) => respondToHandoff("return", reason)}
    />
  ) : null;

  const handleDescriptionDraftChange = (markdown: string) => {
    setDescriptionSaveErrorWorkItemId(null);
    setDescriptionDraftState((current) => {
      if (current?.workItemId === workItem.session_id) {
        return { ...current, value: markdown };
      }
      return {
        workItemId: workItem.session_id,
        base: displayedDescription,
        value: markdown,
      };
    });
  };

  const handleCancelDescription = () => {
    setDescriptionDraftState(null);
    setDescriptionEditWorkItemId(null);
    setDescriptionSaveErrorWorkItemId(null);
  };

  const handleSaveDescription = async () => {
    if (!descriptionHasChanges) return;
    if (isGitHubWorkItem) {
      if (
        !githubIssueInteraction?.canEditBody ||
        githubIssueInteraction.updatingBody
      ) {
        return;
      }
      try {
        await githubIssueInteraction.onUpdateBody(descriptionDraft);
        setDescriptionDraftState(null);
        setDescriptionEditWorkItemId(null);
        setDescriptionSaveErrorWorkItemId(null);
      } catch {
        setDescriptionSaveErrorWorkItemId(workItem.session_id);
      }
      return;
    }
    handleDescriptionChange(descriptionDraft);
    setDescriptionDraftState(null);
    setDescriptionEditWorkItemId(null);
    setDescriptionSaveErrorWorkItemId(null);
  };

  const descriptionActions =
    isThread && canEditDescription && !isEditingThreadDescription ? (
      <ActivityHeaderActionButton
        icon={<Pencil size={12} aria-hidden />}
        label={t("common:actions.edit")}
        onClick={() => {
          setDescriptionSaveErrorWorkItemId(null);
          setDescriptionEditWorkItemId(workItem.session_id);
        }}
        data-testid="work-item-description-edit"
      />
    ) : null;

  const descriptionSection = (
    <TimelineStack>
      <ConnectedTimelineItem
        isLast={
          !isGitHubWorkItem ||
          (!githubTimelineLoading && githubTimeline.length === 0)
        }
        trailLabel={
          isThread
            ? workItem.name ||
              t("common:labels.description", {
                defaultValue: "Description",
              })
            : undefined
        }
      >
        <TimelineCard
          copyBody={normalizedRawDescription}
          actions={descriptionActions}
          className={isThread ? "shadow-sm" : undefined}
          bodyClassName={isThread ? "px-4 py-4" : undefined}
          footer={
            canEditDescription &&
            (isThread ? isEditingThreadDescription : descriptionHasChanges) ? (
              <PanelFooter
                left={
                  isGitHubWorkItem || isThread ? (
                    <MarkdownEditorModeSwitch
                      mode={descriptionEditorMode}
                      onModeChange={setDescriptionEditorMode}
                      disabled={githubIssueInteraction?.updatingBody}
                      dataTestId="work-item-description-mode-switch"
                    />
                  ) : undefined
                }
                secondaryActions={[
                  {
                    label: t("common:actions.cancel"),
                    onClick: handleCancelDescription,
                    disabled: githubIssueInteraction?.updatingBody,
                    dataTestId: "work-item-description-cancel",
                  },
                ]}
                primaryAction={{
                  label: t("common:actions.save"),
                  onClick: () => void handleSaveDescription(),
                  disabled:
                    !descriptionHasChanges ||
                    githubIssueInteraction?.updatingBody,
                  loading: githubIssueInteraction?.updatingBody,
                  dataTestId: "work-item-description-save",
                }}
              />
            ) : null
          }
          header={
            <TimelineCardHeader
              avatar={
                <Avatar
                  size={18}
                  src={workItem.createdBy?.avatar}
                  style={
                    workItem.createdBy?.color
                      ? {
                          backgroundColor: workItem.createdBy.color,
                          color: "var(--color-text-white)",
                        }
                      : undefined
                  }
                >
                  {creatorName.charAt(0).toUpperCase()}
                </Avatar>
              }
              actor={creatorName}
              action={
                isGitHubWorkItem
                  ? t("common:git.issues.activity.opened", "opened this issue")
                  : t(
                      "workItems.activity.openedWorkItem",
                      "opened this work item"
                    )
              }
              timestamp={workItem.created_time}
            />
          }
        >
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
          {(isGitHubWorkItem || isThread) && !isEditingThreadDescription ? (
            <MarkdownContent
              body={displayedDescription}
              emptyText="No description provided."
              fadeFrom="from-chat-pane"
            />
          ) : isGitHubWorkItem ? (
            <>
              <MarkdownTextareaEditor
                value={descriptionDraft}
                onChange={handleDescriptionDraftChange}
                onSubmit={() => void handleSaveDescription()}
                placeholder={t("workItems.descriptionPlaceholder")}
                minHeight={120}
                maxHeight={360}
                appearance="plain"
                editable={
                  canEditDescription && !githubIssueInteraction?.updatingBody
                }
                mode={descriptionEditorMode}
                onModeChange={setDescriptionEditorMode}
                dataTestId="github-issue-description-editor"
              />
              {descriptionSaveErrorWorkItemId === workItem.session_id ? (
                <p className="px-3 pb-2 text-xs text-danger-6" role="status">
                  {t("common:git.issues.composer.bodyUpdateFailed")}
                </p>
              ) : null}
            </>
          ) : (
            <ProjectContentEditor
              key={workItem.session_id}
              ref={editorRef}
              title={workItem.name || ""}
              onTitleChange={handleTitleChange}
              initialDescription={descriptionDraft}
              onDescriptionChange={handleDescriptionDraftChange}
              onImageInsert={canEditDescription ? handleImageInsert : undefined}
              titleVisible={titleVisible}
              separatorVisible={false}
              descriptionPlaceholder={t("workItems.descriptionPlaceholder")}
              editable={canEditDescription}
              descriptionMinHeight={isThread ? 120 : 200}
              descriptionMaxHeight={isThread ? 360 : 600}
              descriptionMode={isThread ? descriptionEditorMode : undefined}
              onDescriptionModeChange={
                isThread ? setDescriptionEditorMode : undefined
              }
              descriptionClassName="no-bottom-border"
              repoPath={repoPath}
              className="w-full"
              dataTestId="work-item-content-editor"
            />
          )}
        </TimelineCard>
      </ConnectedTimelineItem>
      {isGitHubWorkItem ? (
        <IssueTimelineItems
          timeline={githubTimeline}
          timelineLoading={githubTimelineLoading}
          navigationEnabled={isThread}
        />
      ) : null}
    </TimelineStack>
  );

  const todosSection = isThread ? (
    <ThreadTodoChecklist
      key={workItem.session_id}
      todos={workItem.todos ?? []}
      onChange={handleTodosChange}
      disabled={!onUpdateWorkItem}
    />
  ) : (
    <TodoChecklist
      todos={workItem.todos ?? []}
      onChange={handleTodosChange}
      disabled={!onUpdateWorkItem}
    />
  );

  const subItemsSection = (
    <ScrollTrailTarget enabled={isThread} label={t("workItems.subItems.title")}>
      <WorkItemSubItems
        family={subItemFamily}
        parentShortId={shortId ?? workItem.shortId ?? ""}
        projectSlug={projectSlug}
        orgId={orgId}
        onOpenWorkItem={onOpenSubItem}
      />
    </ScrollTrailTarget>
  );

  const customPropertiesSection = !isGitHubWorkItem ? (
    <ScrollTrailTarget
      enabled={isThread}
      label={t("workItems.properties.title", {
        defaultValue: "Custom properties",
      })}
    >
      <CustomPropertiesSection
        projectSlug={projectSlug}
        orgId={orgId}
        shortId={shortId ?? workItem.shortId}
        editable={Boolean(onUpdateWorkItem)}
      />
    </ScrollTrailTarget>
  ) : null;

  const outputContent = (
    <OutputTab
      workItem={workItem}
      repoPath={repoPath}
      projectSlug={projectSlug}
      shortId={shortId ?? workItem.shortId}
      orgId={orgId}
      onOpenFileDiff={onOpenFileDiff}
      onOpenFileAtLine={onOpenFileAtLine}
      onReviewAllFiles={onReviewAllFiles}
      onOpenSession={onOpenSession}
      onCreatePr={onCreatePr}
    />
  );

  const historyContent = (
    <HistoryTab
      key={workItem.session_id}
      timelineEntries={timelineEntries}
      currentUser={currentUser}
      isSubscribed={isSubscribed}
      onToggleSubscribe={handleToggleSubscription}
      commentText={commentText}
      onCommentTextChange={setCommentText}
      mentionRefs={mentionRefs}
      onMentionRefsChange={setMentionRefs}
      agents={mentionAgents}
      agentOrgs={availableOrgs}
      teamMembers={teamMembers}
      onCommentSubmit={handleCommentSubmit}
      isSubmittingComment={isSubmittingComment}
      comments={workItem.comments ?? []}
      replyToCommentId={replyToCommentId}
      onReplyToComment={setReplyToCommentId}
      onResolveThread={handleResolveDiscussionThread}
      onReopenThread={handleReopenDiscussionThread}
      presentation={presentation}
      canComment={Boolean(onUpdateWorkItem)}
      triggerPreview={triggerPreview}
      threadNavigation={
        isThread && activeThreadView === "discussion" ? (
          <WorkItemThreadViewAction
            activeView="discussion"
            onChange={(view) =>
              setThreadViewSelection({
                workItemId: workItem.session_id,
                view,
              })
            }
          />
        ) : undefined
      }
    />
  );

  const tabbedLowerSection = (
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

      {activeSessionTab === "session" &&
        (sectionPolicy.showLinkedSessionsTable ? (
          <LinkedSessionsList
            sessions={workItem.linkedSessions ?? []}
            originSession={workItem.originSession}
            shortId={shortId ?? workItem.shortId}
            projectSlug={projectSlug}
            orgId={orgId}
            activeAgentSessionId={activeAgentSessionId}
            onOpenSession={onOpenSession}
          />
        ) : null)}

      {activeSessionTab === "output" && outputContent}

      {activeSessionTab === "history" && historyContent}
    </section>
  );

  const threadLowerSection = (
    <>
      {!isGitHubWorkItem && !sectionPolicy.showInlineOutput ? (
        <WorkItemRunUsageSummary
          projectSlug={projectSlug}
          orgId={orgId}
          shortId={shortId ?? workItem.shortId}
          navigationEnabled={isThread}
          onOpenSession={onOpenSession}
        />
      ) : null}
      {(workItem.linkedSessions?.length ?? 0) > 0 || workItem.originSession ? (
        <ScrollTrailTarget
          enabled={isThread}
          label={t("workItems.linkedSessions.title", {
            defaultValue: "Sessions",
          })}
        >
          <LinkedSessionsList
            sessions={workItem.linkedSessions ?? []}
            originSession={workItem.originSession}
            shortId={shortId ?? workItem.shortId}
            projectSlug={projectSlug}
            orgId={orgId}
            activeAgentSessionId={activeAgentSessionId}
            onOpenSession={onOpenSession}
          />
        </ScrollTrailTarget>
      ) : null}
      {sectionPolicy.showInlineOutput ? (
        <ScrollTrailTarget
          enabled={isThread}
          label={t("common:labels.output", { defaultValue: "Output" })}
        >
          {outputContent}
        </ScrollTrailTarget>
      ) : null}
    </>
  );

  if (isThread) {
    const githubIssueComposer =
      activeThreadView === "overview" &&
      isGitHubWorkItem &&
      githubIssueInteraction ? (
        <GitHubIssueComposer interaction={githubIssueInteraction} />
      ) : undefined;

    return (
      <WorkItemThreadLayout
        path={headerPath}
        properties={headerProperties}
        floatingFooter={githubIssueComposer}
      >
        {activeThreadView === "overview" ? (
          <>
            {handoffNotice}
            {descriptionSection}
            <ScrollTrailTarget label={t("workItems.todos.title")}>
              {todosSection}
            </ScrollTrailTarget>
            {customPropertiesSection}
            {subItemsSection}
            {threadLowerSection}
            {!isGitHubWorkItem ? (
              <ScrollTrailTarget
                label={t("workItems.activity.discussionTitle")}
              >
                <nav
                  className="flex min-h-8 items-center justify-end"
                  aria-label={t("workItems.activity.discussionTitle")}
                  data-testid="work-item-thread-secondary-navigation"
                >
                  <WorkItemThreadViewAction
                    activeView="overview"
                    onChange={(view) =>
                      setThreadViewSelection({
                        workItemId: workItem.session_id,
                        view,
                      })
                    }
                  />
                </nav>
              </ScrollTrailTarget>
            ) : null}
          </>
        ) : (
          historyContent
        )}
      </WorkItemThreadLayout>
    );
  }

  return (
    <DetailPanelContainer className="relative">
      <WorkItemContentStack
        pathContent={headerPath}
        propertiesContent={headerProperties}
        descriptionContent={
          handoffNotice ? (
            <div className="flex flex-col gap-4">
              {handoffNotice}
              {descriptionSection}
            </div>
          ) : (
            descriptionSection
          )
        }
        todosContent={todosSection}
        lowerContent={
          <>
            {customPropertiesSection}
            {subItemsSection}
            {sectionPolicy.showTabbedLowerSection
              ? tabbedLowerSection
              : threadLowerSection}
          </>
        }
        scrollable
      />
    </DetailPanelContainer>
  );
};

export default WorkItemContent;
