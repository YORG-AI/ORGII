/**
 * Shared "open the billing page" affordance for every desktop paywall
 * touchpoint (plan section, scope-cap hint, retention-expired toasts).
 *
 * Opens billing in the SYSTEM browser. When the desktop is signed in, a
 * one-time bridge link (`POST /api/auth/bridge` with the desktop access
 * token) yields a magiclink verify URL so the browser lands on /billing
 * already signed in. The browser still mints its OWN cookie/refresh
 * lifecycle from that one-time link — the desktop refresh token never
 * leaves the app, so opening Billing can never rotate it. Any bridge
 * failure (signed out, non-200, network, foreign-origin verify URL)
 * falls back to the plain web login returning to billing. After Stripe
 * confirms the plan, the success page navigates to
 * `orgii://billing/complete`, which the OS routes back to the app as a
 * deep link (handled in useDeepLinkHandler).
 */
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAtom } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { z } from "zod/v4";

import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import i18n from "@src/i18n";

import type { SetOrg2CloudAuth } from "./completeSignIn";
import {
  CLOUD_BILLING_PATH,
  buildCloudAuthBridgeUrl,
  buildCloudBillingLoginUrl,
  getCloudEndpoint,
} from "./config";
import {
  type Org2CloudAuthState,
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "./org2CloudAuthAtom";
import { ensureFreshSession } from "./org2CloudClient";

const log = createLogger("Org2CloudBilling");

const BRIDGE_TIMEOUT_MS = 10_000;

const BridgeResponseSchema = z.object({ verifyUrl: z.string() });

async function requestBridgeVerifyUrl(
  accessToken: string
): Promise<string | null> {
  const { webOrigin } = getCloudEndpoint();
  const response = await fetch(buildCloudAuthBridgeUrl(webOrigin), {
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ return_to: CLOUD_BILLING_PATH }),
    signal: AbortSignal.timeout(BRIDGE_TIMEOUT_MS),
  });
  if (!response.ok) {
    log.warn(`billing bridge request failed with status ${response.status}`);
    return null;
  }
  const parsed = BridgeResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    log.warn("billing bridge returned unexpected shape");
    return null;
  }
  const verifyUrl = new URL(parsed.data.verifyUrl);
  if (verifyUrl.origin !== new URL(webOrigin).origin) {
    log.warn("billing bridge verifyUrl is not on the endpoint origin");
    return null;
  }
  return verifyUrl.toString();
}

async function resolveCloudBillingUrl(
  auth: Org2CloudAuthState | null,
  setAuth: SetOrg2CloudAuth
): Promise<string> {
  if (!auth) return buildCloudBillingLoginUrl();
  try {
    const fresh = await ensureFreshSession(auth);
    if (!fresh) return buildCloudBillingLoginUrl();
    commitRefreshedAuth(setAuth, auth, fresh);
    const verifyUrl = await requestBridgeVerifyUrl(fresh.accessToken);
    return verifyUrl ?? buildCloudBillingLoginUrl();
  } catch (error) {
    log.warn("billing bridge failed; falling back to web login", error);
    return buildCloudBillingLoginUrl();
  }
}

export async function openCloudBilling(
  auth: Org2CloudAuthState | null,
  setAuth: SetOrg2CloudAuth
): Promise<void> {
  const url = await resolveCloudBillingUrl(auth, setAuth);
  try {
    await openUrl(url);
  } catch (error) {
    log.error("failed to open ORG2 Cloud billing in system browser", error);
    Message.error(i18n.t("navigation:cloud.billing.openFailed"));
  }
}

/**
 * Stable callback that opens the ORG2 Cloud billing page in the system
 * browser.
 */
export function useOpenCloudBilling(): () => void {
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  return useCallback(() => {
    void openCloudBilling(authRef.current, setAuth);
  }, [setAuth]);
}
