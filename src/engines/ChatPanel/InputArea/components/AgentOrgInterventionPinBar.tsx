import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import type { AgentOrgMemberIntervention } from "@src/api/tauri/agent";
import Button from "@src/components/Button";
import {
  ChatStatusSegmentedBar,
  ChatStatusTwoLineContent,
} from "@src/engines/ChatPanel/components/ChatStatusBanners";
import { HugeiconsIcon, PlayIcon } from "@src/icons";

interface AgentOrgInterventionPinBarProps {
  intervention: AgentOrgMemberIntervention | null;
  memberName?: string | null;
  error: string | null;
  returning: boolean;
  onReturnToWork: () => Promise<boolean>;
}

const AgentOrgInterventionPinBar: React.FC<AgentOrgInterventionPinBarProps> =
  memo(({ intervention, memberName, error, returning, onReturnToWork }) => {
    const { t } = useTranslation("sessions");

    if (!intervention && !error) return null;

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
                  {t("planner.agentOrgIntervention.loadFailed")}
                </span>
              ),
            },
          ]}
        />
      );
    }

    if (!intervention) return null;

    return (
      <ChatStatusSegmentedBar
        testId="agent-org-intervention-pin-bar"
        data-member-id={intervention.memberId}
        data-resume-after={intervention.resumeAfter}
        segments={[
          {
            key: "message",
            className: "flex-1",
            content: (
              <ChatStatusTwoLineContent
                title={t("planner.agentOrgIntervention.title", {
                  member: memberName ?? intervention.memberId,
                })}
                description={t("planner.agentOrgIntervention.description")}
              />
            ),
          },
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
                disabled={returning}
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
        ]}
      />
    );
  });

AgentOrgInterventionPinBar.displayName = "AgentOrgInterventionPinBar";

export default AgentOrgInterventionPinBar;
