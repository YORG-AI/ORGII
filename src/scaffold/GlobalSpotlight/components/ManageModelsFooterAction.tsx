/**
 * ManageModelsFooterAction
 *
 * Preset SpotlightFooterAction that navigates to the models integrations
 * page. Closes the spotlight first via the onClose prop.
 *
 * Navigate state shape is copied verbatim from DispatchCategoryPalette's
 * handleAddModel / UnifiedModelPalette's handleManageModels so behaviour
 * is identical across palettes.
 */
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { ACTION_ID, useActionSystemOptional } from "@src/ActionSystem";
import { buildIntegrationsPath } from "@src/config/mainAppPaths";

import { SpotlightFooterAction } from "./SpotlightFooterAction";

interface ManageModelsFooterActionProps {
  onClose: () => void;
}

export const ManageModelsFooterAction: React.FC<
  ManageModelsFooterActionProps
> = ({ onClose }) => {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const actionSystem = useActionSystemOptional();

  const handleClick = useCallback(() => {
    onClose();
    if (actionSystem?.isValidAction(ACTION_ID.APP_GO_TO_INTEGRATIONS)) {
      void actionSystem.dispatch(ACTION_ID.APP_GO_TO_INTEGRATIONS, {}, "user");
      return;
    }
    navigate(buildIntegrationsPath({ category: "models" }));
  }, [actionSystem, onClose, navigate]);

  return (
    <SpotlightFooterAction
      label={t("selectors.spotlightFooter.manageModels")}
      onClick={handleClick}
    />
  );
};
