/**
 * ManageKeysFooterAction
 *
 * Preset SpotlightFooterAction that navigates to the Key Vault /
 * My Accounts integrations page. Closes the spotlight first via the
 * onClose prop.
 *
 * Navigate state shape is copied verbatim from UnifiedModelPalette's
 * handleManageKeys so behaviour is identical across palettes.
 */
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";

import { ACTION_ID, useActionSystemOptional } from "@src/ActionSystem";
import { buildIntegrationsPath } from "@src/config/mainAppPaths";

import { SpotlightFooterAction } from "./SpotlightFooterAction";

interface ManageKeysFooterActionProps {
  onClose: () => void;
}

export const ManageKeysFooterAction: React.FC<ManageKeysFooterActionProps> = ({
  onClose,
}) => {
  const { t } = useTranslation("common");
  const navigate = useNavigate();
  const actionSystem = useActionSystemOptional();

  const handleClick = useCallback(() => {
    onClose();
    if (actionSystem?.isValidAction(ACTION_ID.APP_GO_TO_MODEL_KEYS)) {
      void actionSystem.dispatch(ACTION_ID.APP_GO_TO_MODEL_KEYS, {}, "user");
      return;
    }
    const path = buildIntegrationsPath({ category: "models" });
    navigate(`${path}?modelsTab=my-accounts`);
  }, [actionSystem, onClose, navigate]);

  return (
    <SpotlightFooterAction
      label={t("selectors.spotlightFooter.manageKeys")}
      onClick={handleClick}
    />
  );
};
