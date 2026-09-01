import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { ACTION_ID, useActionSystemOptional } from "@src/ActionSystem";
import { ROUTES } from "@src/config/routes";

import { SpotlightFooterAction } from "./SpotlightFooterAction";

interface ManageAgentsFooterActionProps {
  onClose: () => void;
}

export const ManageAgentsFooterAction: React.FC<
  ManageAgentsFooterActionProps
> = ({ onClose }) => {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const actionSystem = useActionSystemOptional();

  const handleClick = useCallback(() => {
    onClose();
    if (actionSystem?.isValidAction(ACTION_ID.APP_GO_TO_AGENT_ORGS)) {
      void actionSystem.dispatch(ACTION_ID.APP_GO_TO_AGENT_ORGS, {}, "user");
      return;
    }
    navigate(ROUTES.app.agentOrgs.path);
  }, [actionSystem, onClose, navigate]);

  return (
    <SpotlightFooterAction
      label={t("selectors.spotlightFooter.manageAgents")}
      onClick={handleClick}
    />
  );
};
