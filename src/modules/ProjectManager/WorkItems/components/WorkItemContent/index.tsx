import { useAtomValue } from "jotai";
import React, { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import PersonAvatar from "@src/components/PersonAvatar";
import TabPill from "@src/components/TabPill";
import { useWorkItemImageInsert } from "@src/hooks/project";
import { HugeiconsIcon, Pen01Icon, RepeatIcon } from "@src/icons";
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
import MarkdownTextareaEditor from "@src/modules/shared/components/MarkdownTextareaEditor";
import MarkdownEditorModeSwitch from "@src/modules/shared/components/MarkdownTextareaEditor/ModeSwitch";
import {
  DetailPanelContainer,
  PanelFooter,
  ScrollTrailTarget,
} from "@src/modules/shared/layouts/blocks";
import { WORK_ITEM_STATUS } from "@src/types/core/workItem";

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
import { LinkedSessionsList } from "./LinkedSessionsList";
import OutputTab from "./OutputTab";
import WorkItemHandoffNotice from "./WorkItemHandoffNotice";
import WorkItemRunUsageSummary from "./WorkItemRunUsageSummary";
import { normalizeLegacyEscapedMarkdown } from "./descriptionMarkdown";
import { useGitHubIssueTimeline } from "./hooks/useGitHubIssueTimeline";
import { useWorkItemContentState } from "./hooks/useWorkItemContentState";
import { useWorkItemDescriptionEditing } from "./hooks/useWorkItemDescriptionEditing";
import { useWorkItemHandoff } from "./hooks/useWorkItemHandoff";
import { resolveWorkItemContentSectionPolicy } from "./presentation";
import type { SessionTab, WorkItemContentProps } from "./types";

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
  flowHeader,
  propertiesRail,
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
  const {
    descriptionDraft,
    descriptionHasChanges,
    descriptionEditWorkItemId,
    descriptionSaveErrorWorkItemId,
    descriptionEditorMode,
    setDescriptionEditorMode,
    handleDescriptionDraftChange,
    handleCancelDescription,
    handleSaveDescription,
    beginDescriptionEdit,
  } = useWorkItemDescriptionEditing({
    workItemId: workItem.session_id,
    displayedDescription,
    isGitHubWorkItem,
    githubIssueInteraction,
    onCommitDescription: handleDescriptionChange,
  });
  const [threadViewSelection, setThreadViewSelection] = useState<{
    workItemId: string;
    view: WorkItemThreadView;
  }>({
    workItemId: workItem.session_id,
    view: "overview",
  });
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
  const {
    handoff,
    canRespondToHandoff,
    handoffError,
    handoffResponseUnavailableReason,
    respondingHandoff,
    respondToHandoff,
  } = useWorkItemHandoff({
    workItem,
    shortId,
    projectSlug,
    onTransitionHandoff,
    onRefreshWorkflow,
    currentUser,
    currentUserMemberIds,
    teamMembers,
    t,
  });
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

  const descriptionActions =
    isThread && canEditDescription && !isEditingThreadDescription ? (
      <ActivityHeaderActionButton
        icon={
          <HugeiconsIcon
            icon={Pen01Icon}
            data-icon="pencil"
            size={12}
            aria-hidden
          />
        }
        label={t("common:actions.edit")}
        onClick={beginDescriptionEdit}
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
          className={isThread ? "shadow-xs" : undefined}
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
                <PersonAvatar
                  size={18}
                  name={creatorName}
                  src={workItem.createdBy?.avatar}
                  color={workItem.createdBy?.color}
                />
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
              <HugeiconsIcon
                icon={RepeatIcon}
                data-icon="repeat"
                size={11}
                className="shrink-0"
              />
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

  const subItemsSection = !isGitHubWorkItem ? (
    <ScrollTrailTarget enabled={isThread} label={t("workItems.subItems.title")}>
      <WorkItemSubItems
        family={subItemFamily}
        parentShortId={shortId ?? workItem.shortId ?? ""}
        projectSlug={projectSlug}
        orgId={orgId}
        onOpenWorkItem={onOpenSubItem}
      />
    </ScrollTrailTarget>
  ) : null;

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
      onReviewAllFiles={onReviewAllFiles}
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
        flowHeader={flowHeader}
        sidebar={propertiesRail}
        floatingFooter={githubIssueComposer}
      >
        {activeThreadView === "overview" ? (
          <>
            {handoffNotice}
            {descriptionSection}
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
