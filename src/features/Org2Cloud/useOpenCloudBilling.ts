/**
 * Shared "open the billing page" affordance for every desktop paywall
 * touchpoint (plan section, scope-cap hint, retention-expired toasts).
 *
 * Opens the web login (returning to billing) in the SYSTEM browser. The
 * browser session's cookie/refresh lifecycle is intentionally independent
 * from the desktop session so opening Billing can never rotate the
 * desktop's refresh token. After Stripe confirms the plan, the success
 * page navigates to `orgii://billing/complete`, which the OS routes back
 * to the app as a deep link (handled in useDeepLinkHandler).
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useCallback } from "react";

import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";

import { buildCloudBillingLoginUrl } from "./config";

const log = createLogger("Org2CloudBilling");

/**
 * Stable callback that opens the ORG2 Cloud billing login in the system
 * browser.
 */
export function useOpenCloudBilling(): () => void {
  return useCallback(() => {
    void openUrl(buildCloudBillingLoginUrl()).catch((error: unknown) => {
      log.error("failed to open ORG2 Cloud billing in system browser", error);
      Message.error(i18n.t("navigation:cloud.billing.openFailed"));
    });
  }, []);
}
