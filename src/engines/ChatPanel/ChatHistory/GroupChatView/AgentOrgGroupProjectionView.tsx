import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import type {
  AgentOrgGroupConversationItem,
  AgentOrgGroupProjectionItem,
  AgentOrgRunMemberView,
  AgentOrgRunStatus,
} from "@src/api/tauri/agent";
import { isAgentOrgGroupConversationItem } from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import {
  AlertCircleIcon,
  HierarchyCircle01Icon,
  HugeiconsIcon,
  InformationCircleIcon,
  RotateLeft01Icon,
  SquareIcon,
} from "@src/icons";

import GroupChatMessageBubble from "./GroupChatMessageBubble";

interface AgentOrgGroupProjectionViewProps {
  items: AgentOrgGroupProjectionItem[];
  members: AgentOrgRunMemberView[];
  runStatus: AgentOrgRunStatus;
  loading: boolean;
  hasMore: boolean;
  error: string | null;
  actionError: string | null;
  actionPendingTurns: ReadonlySet<string>;
  overviewPanel: React.ReactNode;
  bottomInset: number;
  onExitGroup: () => void;
  onMemberSelect: (member: AgentOrgRunMemberView) => void;
  onLoadOlder: () => Promise<void>;
  onRetryLoad: () => Promise<void>;
  onStop: (item: AgentOrgGroupConversationItem) => Promise<void>;
  onRetry: (item: AgentOrgGroupConversationItem) => Promise<void>;
}

const GROUP_CHAT_CONTINUATION_WINDOW_MS = 60_000;

function stateDotClass(state: AgentOrgGroupConversationItem["state"]): string {
  switch (state) {
    case "answered":
      return "bg-success-6";
    case "failed":
    case "unknown":
      return "bg-danger-6";
    case "cancelled":
      return "bg-text-3";
    case "running":
      return "bg-primary-6";
    default:
      return "bg-warning-6";
  }
}

function isReplyItem(item: AgentOrgGroupConversationItem): boolean {
  return item.kind === "assistant_reply" || Boolean(item.replyToItemId);
}

function isContinuation(previousAt: string, currentAt: string): boolean {
  const previousMs = new Date(previousAt).getTime();
  const currentMs = new Date(currentAt).getTime();
  return (
    Number.isFinite(previousMs) &&
    Number.isFinite(currentMs) &&
    currentMs >= previousMs &&
    currentMs - previousMs <= GROUP_CHAT_CONTINUATION_WINDOW_MS
  );
}

const AgentOrgGroupProjectionView: React.FC<
  AgentOrgGroupProjectionViewProps
> = ({
  items,
  members,
  runStatus,
  loading,
  hasMore,
  error,
  actionError,
  actionPendingTurns,
  overviewPanel,
  bottomInset,
  onExitGroup,
  onMemberSelect,
  onLoadOlder,
  onRetryLoad,
  onStop,
  onRetry,
}) => {
  const { t } = useTranslation("sessions");
  const [overviewOpen, setOverviewOpen] = useState(false);
  const archived = runStatus === "archived";

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-chat-pane"
      data-testid="agent-org-group-projection"
      aria-label={t("groupChat.projection.title")}
    >
      <header className="flex min-h-10 flex-wrap items-center gap-1 border-b border-border-1 px-2 py-1">
        <Button size="small" variant="primary" disabled>
          {t("groupChat.triggerLabel")}
        </Button>
        {members
          .filter((member) => member.sessionRuntime)
          .map((member) => (
            <Button
              key={member.memberId}
              size="small"
              variant="tertiary"
              appearance="ghost"
              onClick={() => {
                onExitGroup();
                onMemberSelect(member);
              }}
            >
              {member.isCoordinator
                ? t("groupChat.coordinatorLabel")
                : member.name}
            </Button>
          ))}
        <Button
          size="small"
          variant="tertiary"
          appearance="ghost"
          icon={
            <HugeiconsIcon
              icon={HierarchyCircle01Icon}
              data-icon="network"
              size={14}
            />
          }
          aria-expanded={overviewOpen}
          onClick={() => setOverviewOpen((open) => !open)}
        >
          {t("planner.agentOrgOverview.title")}
        </Button>
      </header>

      {overviewOpen && (
        <div className="max-h-96 flex-shrink-0 overflow-y-auto border-b border-border-1 p-2">
          {overviewPanel}
        </div>
      )}

      <div
        className="scrollbar-hide min-h-0 flex-1 overflow-y-auto px-3 py-3"
        style={{ paddingBottom: Math.max(bottomInset, 16) }}
      >
        <div
          className={`mx-auto w-full ${DETAIL_PANEL_TOKENS.contentMaxWidth}`}
        >
          <div className="mb-3 flex items-center gap-2 px-2 text-xs text-text-3">
            <HugeiconsIcon
              icon={InformationCircleIcon}
              data-icon="info"
              size={14}
              className="shrink-0"
              aria-hidden
            />
            {t("groupChat.projection.queueGuidance")}
          </div>

          {archived && (
            <div
              role="status"
              className="mb-3 border-l-2 border-border-2 px-3 py-1 text-xs text-text-3"
            >
              {t("groupChat.projection.archived")}
            </div>
          )}

          {hasMore && (
            <Button
              size="small"
              variant="tertiary"
              loading={loading}
              data-testid="agent-org-group-projection-load-older"
              onClick={() => void onLoadOlder()}
            >
              {t("groupChat.projection.loadOlder")}
            </Button>
          )}

          {error && (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 rounded-lg border border-danger-3 bg-danger-1 px-3 py-2 text-sm text-danger-6"
            >
              <span className="flex items-center gap-2">
                <HugeiconsIcon
                  icon={AlertCircleIcon}
                  data-icon="alert-circle"
                  size={16}
                />
                {t("groupChat.projection.loadError")}
              </span>
              <Button size="small" onClick={() => void onRetryLoad()}>
                {t("groupChat.retry")}
              </Button>
            </div>
          )}

          {actionError && (
            <div
              role="alert"
              className="rounded-lg bg-danger-1 px-3 py-2 text-sm text-danger-6"
            >
              {t("groupChat.projection.actionError")}
            </div>
          )}

          {loading && items.length === 0 && (
            <div
              className="py-8 text-center text-sm text-text-3"
              data-testid="agent-org-group-projection-loading"
            >
              {t("groupChat.projection.loading")}
            </div>
          )}

          {!loading && !error && items.length === 0 && (
            <div
              className="py-8 text-center text-sm text-text-3"
              data-testid="agent-org-group-projection-empty"
            >
              {t("groupChat.projection.empty")}
            </div>
          )}

          {items.map((item, index) => {
            if (item.kind === "team_activity") {
              const memberName =
                item.memberName?.trim() || t("groupChat.memberFallback");
              const previousMemberName =
                item.previousMemberName?.trim() ||
                t("groupChat.memberFallback");
              const taskSubject =
                item.taskSubject?.trim() ||
                t("groupChat.projection.activity.taskFallback");
              const replacedTaskSubject =
                item.replacedTaskSubject?.trim() ||
                t("groupChat.projection.activity.taskFallback");
              return (
                <div
                  key={item.id}
                  role="status"
                  className="mx-2 my-2 flex items-start gap-2 border-l-2 border-border-2 px-3 py-1.5 text-xs text-text-3"
                  data-testid="agent-org-group-projection-activity"
                  data-item-kind={item.kind}
                  data-activity-kind={item.activityKind}
                >
                  <HugeiconsIcon
                    icon={InformationCircleIcon}
                    data-icon="info"
                    size={14}
                    className="mt-0.5 shrink-0"
                    aria-hidden
                  />
                  <span className="min-w-0 flex-1">
                    {t(`groupChat.projection.activity.${item.activityKind}`, {
                      member: memberName,
                      previousMember: previousMemberName,
                      task: taskSubject,
                      replacedTask: replacedTaskSubject,
                      outcome: item.outcome ?? "",
                    })}
                  </span>
                  <time className="shrink-0" dateTime={item.createdAt}>
                    {new Date(item.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </time>
                </div>
              );
            }

            if (item.kind === "diagnostic") {
              return (
                <div
                  key={item.id}
                  role="status"
                  className="bg-secondary-1 mx-2 my-2 flex items-center gap-2 rounded-md px-3 py-2 text-xs text-text-3"
                  data-testid="agent-org-group-projection-diagnostic"
                  data-item-kind={item.kind}
                >
                  <HugeiconsIcon
                    icon={AlertCircleIcon}
                    data-icon="alert-circle"
                    size={14}
                    className="shrink-0"
                    aria-hidden
                  />
                  <span>{t("groupChat.projection.unavailable")}</span>
                </div>
              );
            }

            const pending = actionPendingTurns.has(item.turnIntentId);
            const targetName =
              item.targetName.trim() || t("groupChat.memberFallback");
            const responderName = item.responderName?.trim() || targetName;
            const reply = isReplyItem(item);
            const sender = reply ? responderName : t("groupChat.youLabel");
            const previousCandidate = index > 0 ? items[index - 1] : null;
            const previous =
              previousCandidate &&
              isAgentOrgGroupConversationItem(previousCandidate)
                ? previousCandidate
                : null;
            const previousTargetName =
              previous?.targetName.trim() || t("groupChat.memberFallback");
            const previousSender = previous
              ? isReplyItem(previous)
                ? previous.responderName?.trim() || previousTargetName
                : t("groupChat.youLabel")
              : null;
            const showSenderChrome =
              previousSender !== sender ||
              !previous ||
              !isContinuation(previous.createdAt, item.createdAt);
            const state = item.state ?? "unknown";
            return (
              <div
                key={item.id}
                className={showSenderChrome ? "pt-2" : "pt-1"}
                data-testid="agent-org-group-projection-item"
                data-turn-intent-id={item.turnIntentId}
                data-item-kind={item.kind}
                data-route={item.route}
                data-target-name={targetName}
                data-responder-name={responderName}
                data-state={state}
              >
                <GroupChatMessageBubble
                  senderName={sender}
                  recipientName={reply ? null : targetName}
                  bodyMarkdown={item.text}
                  timestamp={item.createdAt}
                  showSenderChrome={showSenderChrome}
                  clampContent={false}
                  footer={
                    <>
                      <span className="inline-flex items-center gap-1">
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${stateDotClass(state)}`}
                          aria-hidden
                        />
                        <span>{reply ? responderName : targetName}</span>
                        <span aria-hidden>·</span>
                        <span>{t(`groupChat.projection.state.${state}`)}</span>
                      </span>
                      {!archived &&
                        !reply &&
                        (item.canStop || item.retryMode) && (
                          <span className="inline-flex items-center gap-1">
                            {item.canStop && (
                              <Button
                                size="mini"
                                variant="danger"
                                appearance="ghost"
                                icon={
                                  <HugeiconsIcon
                                    icon={SquareIcon}
                                    data-icon="square"
                                    size={12}
                                  />
                                }
                                loading={pending}
                                disabled={pending}
                                data-testid="agent-org-group-projection-stop"
                                onClick={() => void onStop(item)}
                              >
                                {t("groupChat.projection.stop")}
                              </Button>
                            )}
                            {item.retryMode && (
                              <Button
                                size="mini"
                                variant="tertiary"
                                appearance="ghost"
                                icon={
                                  <HugeiconsIcon
                                    icon={RotateLeft01Icon}
                                    data-icon="rotate-ccw"
                                    size={13}
                                  />
                                }
                                loading={pending}
                                disabled={pending}
                                data-testid="agent-org-group-projection-retry"
                                onClick={() => void onRetry(item)}
                              >
                                {item.retryMode === "rekick"
                                  ? t("groupChat.projection.retryDelivery")
                                  : t("groupChat.projection.retryNewTurn")}
                              </Button>
                            )}
                          </span>
                        )}
                    </>
                  }
                />
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
};

AgentOrgGroupProjectionView.displayName = "AgentOrgGroupProjectionView";

export default AgentOrgGroupProjectionView;
