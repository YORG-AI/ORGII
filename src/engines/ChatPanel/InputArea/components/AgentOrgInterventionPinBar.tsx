import React, { memo, useRef } from "react";
import { useTranslation } from "react-i18next";

import type {
  AgentOrgMemberIntervention,
  AgentOrgRunMemberView,
  AgentOrgRunStatus,
  ReturnToWorkResult,
} from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import { Message } from "@src/components/Message";
import { AgentOrgWriterBadge } from "@src/engines/ChatPanel/blocks/OrgTaskBadges";
import {
  ChatStatusSegmentedBar,
  ChatStatusTwoLineContent,
} from "@src/engines/ChatPanel/components/ChatStatusBanners";
import {
  CheckmarkCircle01Icon,
  HugeiconsIcon,
  PlayIcon,
  SquareIcon,
} from "@src/icons";

interface AgentOrgInterventionPinBarProps {
  intervention: AgentOrgMemberIntervention | null;
  member: AgentOrgRunMemberView;
  runStatus: AgentOrgRunStatus | null;
  error: string | null;
  returning: boolean;
  stopping: boolean;
  onReturnToWork: () => Promise<ReturnToWorkResult | null>;
  onStopUserDirectedWork: () => Promise<boolean>;
}

function returnNoticeKey(result: ReturnToWorkResult): string {
  switch (result.appliedOutcome) {
    case "restored_task":
      return "planner.agentOrgIntervention.outcome.restoredTask";
    case "cleared_paused":
      return "planner.agentOrgIntervention.outcome.clearedPaused";
    case "cleared_idle":
      return "planner.agentOrgIntervention.outcome.clearedIdle";
    case "no_longer_needed":
      return result.hadOriginalFormalWork
        ? "planner.agentOrgIntervention.outcome.noLongerNeeded"
        : "planner.agentOrgIntervention.outcome.directEnded";
  }
}

const AgentOrgInterventionPinBar: React.FC<AgentOrgInterventionPinBarProps> =
  memo(
    ({
      intervention,
      member,
      runStatus,
      error,
      returning,
      stopping,
      onReturnToWork,
      onStopUserDirectedWork,
    }) => {
      const { t } = useTranslation("sessions");
      const lastReturnNoticeRef = useRef<string | null>(null);

      if (error) {
        return (
          <ChatStatusSegmentedBar
            testId="agent-org-intervention-error"
            segments={[
              {
                key: "error",
                className: "text-error-6",
                content: (
                  <span className="truncate">
                    {t("planner.agentOrgIntervention.actionFailed")}
                  </span>
                ),
              },
            ]}
          />
        );
      }

      const activityKind = member.activity?.kind ?? null;
      const description = intervention?.failureReason
        ? t("planner.agentOrgIntervention.directUnknown")
        : activityKind === "side_quest" && member.queuedUserDirectedCount === 0
          ? t("planner.agentOrgIntervention.directReady")
          : activityKind
            ? t(`planner.agentOrgIntervention.activity.${activityKind}`, {
                count: member.queuedUserDirectedCount,
              })
            : runStatus === "starting"
              ? t("planner.agentOrgIntervention.unavailableStarting")
              : runStatus === "failed"
                ? t("planner.agentOrgIntervention.unavailableFailed")
                : runStatus === "paused"
                  ? t("planner.agentOrgIntervention.directPaused")
                  : t("planner.agentOrgIntervention.directNotice");
      const hasUserDirectedTurn = member.queuedUserDirectedCount > 0;
      const canResolveDirectWork =
        intervention?.status === "active" && !hasUserDirectedTurn;
      const canRestoreFormalWork = Boolean(
        runStatus === "running" &&
        intervention?.originalTaskId &&
        intervention.originalTurnIntentId
      );
      const returnControlTestId = canRestoreFormalWork
        ? "agent-org-return-to-work-button"
        : "agent-org-end-direct-work-button";
      const handleReturnToWork = async () => {
        const result = await onReturnToWork();
        if (!result) return;
        const noticeIdentity = `${result.interventionReceiptId}:${result.clearedRevision}`;
        if (lastReturnNoticeRef.current === noticeIdentity) return;
        lastReturnNoticeRef.current = noticeIdentity;
        Message.success(t(returnNoticeKey(result)), { duration: 4000 });
      };

      return (
        <ChatStatusSegmentedBar
          testId="agent-org-member-direct-work-bar"
          data-member-id={member.memberId}
          data-writer-capable={member.writerCapable || undefined}
          data-activity-kind={activityKind ?? undefined}
          data-user-directed-queue-count={member.queuedUserDirectedCount}
          data-intervention-receipt-id={
            intervention?.interventionReceiptId ??
            member.activity?.interventionReceiptId
          }
          data-intervention-status={intervention?.status}
          segments={[
            {
              key: "message",
              className: "flex-1",
              content: (
                <ChatStatusTwoLineContent
                  title={
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      <span className="truncate">
                        {t("planner.agentOrgIntervention.directTitle", {
                          member: member.name,
                        })}
                      </span>
                      {member.writerCapable && (
                        <AgentOrgWriterBadge>
                          {t("planner.agentOrgIntervention.writerBadge")}
                        </AgentOrgWriterBadge>
                      )}
                    </span>
                  }
                  description={description}
                />
              ),
            },
            ...(hasUserDirectedTurn
              ? [
                  {
                    key: "stop",
                    className: "shrink-0 px-0",
                    content: (
                      <Button
                        variant="tertiary"
                        shape="round"
                        size="mini"
                        htmlType="button"
                        data-testid="agent-org-stop-user-directed-work-button"
                        disabled={stopping || returning}
                        loading={stopping}
                        loadingSpinIcon
                        onClick={() => void onStopUserDirectedWork()}
                        icon={
                          <HugeiconsIcon
                            icon={SquareIcon}
                            data-icon="stop"
                            size={10}
                            strokeWidth={2}
                          />
                        }
                      >
                        {stopping
                          ? t("planner.agentOrgIntervention.stopping")
                          : t("common:actions.stop")}
                      </Button>
                    ),
                  },
                ]
              : []),
            ...(intervention
              ? [
                  {
                    key: "return",
                    className: "shrink-0 px-0",
                    content: (
                      <Button
                        variant="secondary"
                        shape="round"
                        size="mini"
                        htmlType="button"
                        data-testid={returnControlTestId}
                        disabled={
                          !canResolveDirectWork || returning || stopping
                        }
                        loading={returning}
                        loadingSpinIcon
                        onClick={() => void handleReturnToWork()}
                        icon={
                          <HugeiconsIcon
                            icon={
                              canRestoreFormalWork
                                ? PlayIcon
                                : CheckmarkCircle01Icon
                            }
                            data-icon={canRestoreFormalWork ? "play" : "check"}
                            size={12}
                            strokeWidth={2}
                          />
                        }
                      >
                        {returning
                          ? t(
                              canRestoreFormalWork
                                ? "planner.agentOrgIntervention.returning"
                                : "planner.agentOrgIntervention.endingDirectWork"
                            )
                          : t(
                              canRestoreFormalWork
                                ? "planner.agentOrgIntervention.returnToWork"
                                : "planner.agentOrgIntervention.endDirectWork"
                            )}
                      </Button>
                    ),
                  },
                ]
              : []),
          ]}
        />
      );
    }
  );

AgentOrgInterventionPinBar.displayName = "AgentOrgInterventionPinBar";

export default AgentOrgInterventionPinBar;
