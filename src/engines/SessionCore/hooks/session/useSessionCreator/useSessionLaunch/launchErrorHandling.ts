import type { TFunction } from "i18next";

import { ORGII_ORCHESTRATOR } from "@src/assets/providers";
import { Message } from "@src/components/Message";
import type { AdvancedConfig } from "@src/features/SessionCreator/types";

import {
  formatAgentLaunchError,
  isAuthError,
  isBalanceError,
  isRunQueuedBehindCheckout,
} from "./errorUtils";

export interface HandleLaunchErrorOptions {
  advancedConfig: AdvancedConfig;
  clearDraft: (draft: null) => void;
  error: unknown;
  setShowAddFundsModal: (show: boolean) => void;
  setShowBuyCreditsModal: (show: boolean) => void;
  showAuthError: () => void;
  t: TFunction;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unexpected error occurred";
}

export function handleNonCursorLaunchError(
  options: HandleLaunchErrorOptions
): void {
  const {
    advancedConfig,
    clearDraft,
    error,
    setShowAddFundsModal,
    setShowBuyCreditsModal,
    showAuthError,
    t,
  } = options;
  const errorMessage = getErrorMessage(error);

  if (isRunQueuedBehindCheckout(errorMessage)) {
    clearDraft(null);
    Message.info(t("errors.runQueuedBehindCheckout"));
    return;
  }

  if (isAuthError(errorMessage)) {
    clearDraft(null);
    showAuthError();
    return;
  }

  if (isBalanceError(errorMessage)) {
    clearDraft(null);
    if (advancedConfig.listingModelType === ORGII_ORCHESTRATOR) {
      setShowBuyCreditsModal(true);
    } else {
      setShowAddFundsModal(true);
    }
    Message.error(t("errors.insufficientBalance"));
    return;
  }

  Message.error(formatAgentLaunchError(errorMessage));
}
