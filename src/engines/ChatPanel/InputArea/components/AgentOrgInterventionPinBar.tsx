import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import type {
  AgentOrgMemberIntervention,
  AgentOrgRunMemberView,
  AgentOrgRunStatus,
  ReturnToWorkOutcome,
  ReturnToWorkResult,
} from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import { AgentOrgWriterBadge } from "@src/engines/ChatPanel/blocks/OrgTaskBadges";
import {
  ChatStatusSegmentedBar,
  ChatStatusTwoLineContent,
} from "@src/engines/ChatPanel/components/ChatStatusBanners";
import { HugeiconsIcon, PlayIcon, SquareIcon } from "@src/icons";

interface AgentOrgInterventionPinBarProps {
  intervention: AgentOrgMemberIntervention | null;
  member: AgentOrgRunMemberView;
  runStatus: AgentOrgRunStatus | null;
  error: string | null;
  returning: boolean;
  stopping: boolean;
  returnOutcome: ReturnToWorkOutcome | null;
  onReturnToWork: () => Promise<ReturnToWorkResult | null>;
  onStopUserDirectedWork: () => Promise<boolean>;
}

const RETURN_OUTCOME_KEYS: Record<ReturnToWorkOutcome, string> = {
  restored_task: "planner.agentOrgIntervention.outcome.restoredTask",
  cleared_paused: "planner.agentOrgIntervention.outcome.clearedPaused",
  cleared_idle: "planner.agentOrgIntervention.outcome.clearedIdle",
  no_longer_needed: "planner.agentOrgIntervention.outcome.noLongerNeeded",
  already_applied: "planner.agentOrgIntervention.outcome.alreadyApplied",
};

const AgentOrgInterventionPinBar: React.FC<AgentOrgInterventionPinBarProps> =
  memo(
    ({
      intervention,
      member,
      runStatus,
      error,
      returning,
      stopping,
      returnOutcome,
      onReturnToWork,
      onStopUserDirectedWork,
    }) => {
      const { t } = useTranslation("sessions");

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
      const description = returnOutcome
        ? t(RETURN_OUTCOME_KEYS[returnOutcome])
        : intervention?.failureReason
          ? t("planner.agentOrgIntervention.directUnknown")
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
      const canReturn =
        intervention?.status === "active" && !hasUserDirectedTurn;

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
                        data-testid="agent-org-return-to-work-button"
                        disabled={!canReturn || returning || stopping}
                        loading={returning}
                        loadingSpinIcon
                        onClick={() => void onReturnToWork()}
                        icon={
                          <HugeiconsIcon
                            icon={PlayIcon}
                            data-icon="play"
                            size={12}
                            strokeWidth={2}
                          />
                        }
                      >
                        {returning
                          ? t("planner.agentOrgIntervention.returning")
                          : t("planner.agentOrgIntervention.returnToWork")}
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
