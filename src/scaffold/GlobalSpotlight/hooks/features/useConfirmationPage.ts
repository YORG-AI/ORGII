/**
 * useConfirmationPage Hook
 *
 * Manages the confirmation stage where users review and confirm their action.
 * Replaces the countdown system with an expanded confirmation page.
 */
import { type ComponentType, useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import {
  LANGUAGE_NAMES,
  LANGUAGE_PREFERENCE,
  type SupportedLanguage,
  getFollowSystemLanguageLabel,
} from "@src/i18n";
import type { IconSvgElement } from "@src/icons";
import { REPO_KIND } from "@src/store/repo";

import { ICONS } from "../../config";
import { useSpotlightDispatch, useSpotlightState } from "../core";
import type { UseConfirmationPageReturn } from "../core/types";

// ============================================
// Hook Implementation
// ============================================

export function useConfirmationPage(
  onExecute: () => void
): UseConfirmationPageReturn {
  const state = useSpotlightState();
  const dispatch = useSpotlightDispatch();
  const { t } = useTranslation();

  const showConfirmation = state.stage === "confirming";

  // Format confirmation data
  const confirmationData = useMemo(() => {
    if (!showConfirmation || !state.currentAction) {
      return null;
    }

    const action = state.currentAction;
    const parameters: Array<{
      label: string;
      value: string;
      icon?: string | IconSvgElement | ComponentType<Record<string, unknown>>;
    }> = [];

    // Add repo parameter
    if (state.currentRepo) {
      const isFolder = state.currentRepo.kind === REPO_KIND.FOLDER;
      parameters.push({
        label: isFolder
          ? t("selectors.spotlight.paramLabels.folder")
          : t("selectors.spotlight.paramLabels.repo"),
        value: state.currentRepo.name,
        icon: isFolder ? ICONS.folder : ICONS.repo,
      });
    }

    // Add branch parameter
    if (state.currentBranch) {
      parameters.push({
        label: t("selectors.spotlight.paramLabels.branch"),
        value: state.currentBranch,
        icon: ICONS.branch,
      });
    }

    if (state.currentLanguage) {
      parameters.push({
        label: t("settings:general.language"),
        value:
          state.currentLanguage === LANGUAGE_PREFERENCE.SYSTEM
            ? getFollowSystemLanguageLabel(t("settings:general.followSystem"))
            : LANGUAGE_NAMES[state.currentLanguage as SupportedLanguage],
        icon: ICONS.language,
      });
    }

    return {
      actionLabel: action.labelKey ? t(action.labelKey) : action.label,
      actionIcon: action.icon,
      parameters,
    };
  }, [
    showConfirmation,
    state.currentAction,
    state.currentRepo,
    state.currentBranch,
    state.currentLanguage,
    t,
  ]);

  // Confirm and execute
  const confirm = useCallback(() => {
    dispatch({ type: "START_EXECUTING" });
    onExecute();
  }, [dispatch, onExecute]);

  // Go back to parameter selection
  const back = useCallback(() => {
    dispatch({ type: "BACK_FROM_CONFIRMING" });
  }, [dispatch]);

  return {
    showConfirmation,
    confirmationData,
    confirm,
    back,
  };
}
