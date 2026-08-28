/**
 * PlanApprovalActions
 *
 * Action row for the Agent Station Communication plan preview (issue #28).
 * Lets the user edit a pending plan directly in the agent's workstation
 * (Edit → Cancel/Save) and jump to the plan file in My Station.
 *
 * Mirrors the chat-panel `CreatePlanCard` focus rule: while editing, only the
 * relevant edit actions (Cancel + Save) are shown; the unrelated actions
 * (Edit toggle, Open in My Station) are hidden.
 */
import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  Cancel01Icon,
  CheckmarkCircle01Icon,
  HugeiconsIcon,
  Pen01Icon,
  SquareArrowUpRightIcon,
} from "@src/icons";

const ICON_SIZE = 12;

export interface PlanApprovalActionsProps {
  isEditing: boolean;
  submitting: boolean;
  /** Save is disabled until the plan is actually pending / not mid-build. */
  saveDisabled: boolean;
  /** Whether "Open in My Station" is available (plan path resolved). */
  canOpenInMyStation: boolean;
  onEditToggle: () => void;
  onSave: () => void;
  onOpenInMyStation: () => void;
}

const PlanApprovalActions: React.FC<PlanApprovalActionsProps> = ({
  isEditing,
  submitting,
  saveDisabled,
  canOpenInMyStation,
  onEditToggle,
  onSave,
  onOpenInMyStation,
}) => {
  const { t } = useTranslation("sessions");

  if (isEditing) {
    return (
      <>
        <Button
          size="mini"
          data-testid="plan-approval-cancel"
          onClick={onEditToggle}
          disabled={submitting}
          icon={
            <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={ICON_SIZE} />
          }
        >
          {t("planDoc.cancelEdit")}
        </Button>
        <Button
          variant="primary"
          size="mini"
          data-testid="plan-approval-save"
          onClick={onSave}
          disabled={saveDisabled}
          icon={
            <HugeiconsIcon
              icon={CheckmarkCircle01Icon}
              data-icon="check-circle-2"
              size={ICON_SIZE}
            />
          }
        >
          {t("common:actions.save")}
        </Button>
      </>
    );
  }

  return (
    <>
      <Button
        size="mini"
        data-testid="plan-approval-edit"
        onClick={onEditToggle}
        disabled={saveDisabled}
        icon={
          <HugeiconsIcon icon={Pen01Icon} data-icon="pencil" size={ICON_SIZE} />
        }
      >
        {t("planDoc.edit")}
      </Button>
      {canOpenInMyStation && (
        <Button
          size="mini"
          data-testid="plan-approval-open-my-station"
          onClick={onOpenInMyStation}
          icon={
            <HugeiconsIcon
              icon={SquareArrowUpRightIcon}
              data-icon="square-arrow-out-up-right"
              size={ICON_SIZE}
            />
          }
        >
          {t("controlTower.sidebar.openInMyStation")}
        </Button>
      )}
    </>
  );
};

export default memo(PlanApprovalActions);
