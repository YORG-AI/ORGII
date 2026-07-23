/**
 * Deep Link Handler Hook
 *
 * Handles deep link URLs (yorgai:// and orgii://) in Tauri production mode.
 * This is critical for:
 *   - OAuth callbacks where Supabase redirects to yorgai://marketplace/callback
 *     after authentication.
 *   - ORG2 Cloud invite links (orgii://cloud/join?invite=…) and session
 *     share links (orgii://cloud/session?share=…) which route into their
 *     confirmation dialogs.
 *   - Non-secret ORG2 session references
 *     (orgii://cloud/session/ref?v=1&org=…&owner=…&session=…) copied into
 *     issue trackers and pull requests, which reveal the exact Team row.
 *   - ORG2 Cloud login callbacks orgii://auth/callback#access_token=… whose
 *     tokens ride in the URL FRAGMENT (design §8). Intercepted on the RAW
 *     url BEFORE the generic route conversion (which would otherwise strip
 *     the fragment into a dead-end /orgii/auth/callback navigation).
 *   - ORG2 Cloud billing completions (orgii://billing/complete) fired by
 *     the billing success page after Stripe confirms the plan; re-emitted
 *     as the `org2-cloud-billing-complete` event for the org panel.
 *
 * The hook listens for deep link events from Tauri and either routes the
 * React Router to the appropriate path or opens the matching cloud dialog.
 */
import { emit } from "@tauri-apps/api/event";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { useCallback, useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";

import { ROUTES } from "@src/config/routes";
import {
  isOrg2CloudAuthCallback,
  parseAuthCallbackFragment,
} from "@src/features/Org2Cloud/authCallback";
import { isBillingCompleteDeepLink } from "@src/features/Org2Cloud/billingComplete";
import { buildCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import {
  type CloudSessionReference,
  parseCloudSessionReference,
} from "@src/features/Org2Cloud/cloudSessionReference";
import { completeOrg2CloudSignIn } from "@src/features/Org2Cloud/completeSignIn";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  completePendingOrg2CloudAuthLoopback,
  readPendingOrg2CloudAuthLoopback,
  schedulePendingOrg2CloudAuthLoopbackExpiry,
} from "@src/features/Org2Cloud/org2CloudAuthLoopback";
import { resetOrgEntitlementCoordinator } from "@src/features/Org2Cloud/org2CloudEntitlementCoordinator";
import {
  type CloudInviteDeepLink,
  type CloudShareDeepLink,
  parseCloudInviteDeepLink,
  parseCloudShareDeepLink,
} from "@src/features/Org2Cloud/org2CloudOrgManagement";
import { org2CloudPendingInviteAtom } from "@src/features/Org2Cloud/org2CloudPendingInviteAtom";
import {
  org2CloudPendingShareAtom,
  queueOrg2CloudPendingShareAtom,
} from "@src/features/Org2Cloud/org2CloudPendingShareAtom";
import { log, logDebug, logError, logWarn } from "@src/hooks/logger";
import { activeStationChatVisibleAtom } from "@src/store/ui/chatPanelAtom";
import { requestSessionSidebarRevealAtom } from "@src/store/ui/sidebarAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { isTauriReady } from "@src/util/platform/tauri/init";

/**
 * Track a share deep-link URL as re-armable (design §6.4). A share link is
 * one-shot plaintext the owner can't regenerate, so unlike a join link it
 * must stay re-clickable after its import dialog is dismissed. When a NEW
 * share link supersedes one whose dialog was never dismissed, the old URL is
 * re-armed (removed from the dedup set) IMMEDIATELY — otherwise it would be
 * dedup-blocked forever, because the dismiss-time sweep only sees the
 * currently tracked set.
 *
 * Exported for tests; pure with respect to its arguments.
 */
export function trackReArmableShareUrl(
  processedUrls: Set<string>,
  reArmableShareUrls: Set<string>,
  url: string
): void {
  for (const pendingUrl of reArmableShareUrls) {
    if (pendingUrl !== url) processedUrls.delete(pendingUrl);
  }
  reArmableShareUrls.clear();
  reArmableShareUrls.add(url);
}

/**
 * Re-arm every tracked share URL once the pending share clears (dialog
 * dismissed or import finished): drop them from the dedup set so re-clicking
 * the same one-shot link re-opens the dialog. Exported for tests.
 */
export function reArmTrackedShareUrls(
  processedUrls: Set<string>,
  reArmableShareUrls: Set<string>
): void {
  for (const url of reArmableShareUrls) {
    processedUrls.delete(url);
  }
  reArmableShareUrls.clear();
}

/**
 * Parse a deep link URL and extract the path and query string
 * @param deepLinkUrl - The deep link URL (e.g., yorgai://marketplace/callback?code=xxx)
 * @returns Object with path and search, or null if invalid
 */
function parseDeepLink(
  deepLinkUrl: string
): { path: string; search: string } | null {
  try {
    // Deep links come in format: <scheme>://path or <scheme>://path?query
    // We convert to React Router path: /orgii/path?query
    //
    // Two distinct identifiers — do not collapse:
    //   - URL schemes `yorgai://` / `orgii://` — the OS-level deep link
    //     protocols; both must be listed in tauri.conf.json's
    //     `deep-link.desktop.schemes`. `yorgai` must also be registered in
    //     Supabase Auth redirect URLs so production desktop OAuth callbacks
    //     can return to the app.
    //   - In-app route prefix `/orgii` — the React Router base path.
    //
    // NOTE: `orgii://cloud/join` and `orgii://cloud/session` are intercepted
    // earlier (see `parseCloudInviteDeepLink` / `parseCloudShareDeepLink`)
    // and never reach this generic conversion.

    const withoutProtocol = deepLinkUrl.replace(/^(?:yorgai|orgii):\/\//, "");

    // Split path and query
    const [pathPart, ...queryParts] = withoutProtocol.split("?");
    const search = queryParts.length > 0 ? `?${queryParts.join("?")}` : "";

    // Normalize the path - add /orgii prefix if not present
    let path = pathPart;
    if (!path.startsWith("/")) {
      path = "/" + path;
    }
    if (!path.startsWith("/orgii")) {
      path = "/orgii" + path;
    }

    return { path, search };
  } catch (error) {
    logError("DeepLinkHandler", "Failed to parse deep link:", error);
    return null;
  }
}

/**
 * Hook to handle deep link navigation
 * Should be mounted once at the app root level
 */
export function useDeepLinkHandler(): void {
  const navigate = useNavigate();
  const setPendingCloudInvite = useSetAtom(org2CloudPendingInviteAtom);
  const queuePendingCloudShare = useSetAtom(queueOrg2CloudPendingShareAtom);
  const requestSessionSidebarReveal = useSetAtom(
    requestSessionSidebarRevealAtom
  );
  const pendingCloudShare = useAtomValue(org2CloudPendingShareAtom);
  const setStationMode = useSetAtom(stationModeAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);
  const setOrg2CloudAuth = useSetAtom(org2CloudAuthAtom);
  const store = useStore();
  const hasSetupListener = useRef(false);
  const hasProcessedInitialDeepLink = useRef(false);
  const processedDeepLinks = useRef<Set<string>>(new Set());
  // Cloud share links (orgii://cloud/session) waiting to be re-armed (see
  // trackReArmableShareUrl): dropped from the dedup set once the pending
  // share clears, so the one-shot link stays re-clickable after the dialog
  // is dismissed without importing.
  const reArmableCloudShareUrls = useRef<Set<string>>(new Set());
  const unlistenRef = useRef<(() => void) | null>(null);
  const oauthUnlistenRef = useRef<(() => void) | null>(null);

  // Cloud share re-arm: once the pending share clears (dialog dismissed or
  // import done), re-arm the tracked links so re-clicking the same one-shot
  // URL re-opens the dialog.
  useEffect(() => {
    if (
      pendingCloudShare === null &&
      reArmableCloudShareUrls.current.size > 0
    ) {
      reArmTrackedShareUrls(
        processedDeepLinks.current,
        reArmableCloudShareUrls.current
      );
    }
  }, [pendingCloudShare]);

  // Route an incoming CLOUD session share (orgii://cloud/session?share=…,
  // migration 0012): park the token in the one-shot pending atom (consumed
  // by CloudShareImportDialog) and surface the Workstation. The token is the
  // whole credential; only non-secret endpoint provenance rides beside it.
  const routeToCloudShare = useCallback(
    (share: CloudShareDeepLink) => {
      queuePendingCloudShare(share);
      setStationMode("my-station");
      setStationChatVisible("my-station", true);
      if (window.location.pathname !== ROUTES.workStation.code.path) {
        navigate(ROUTES.workStation.code.path);
      }
    },
    [navigate, queuePendingCloudShare, setStationChatVisible, setStationMode]
  );

  // Route an incoming ORG2 Cloud invite (`orgii://cloud/join?invite=…`)
  // into the join confirmation: park the code in the pending atom (consumed
  // by JoinCloudOrgDialog on the Workstation surface) and make sure that
  // surface is visible. No Rust involvement — the link rides the same
  // deep-link plugin delivery as the collaboration links.
  const routeToCloudJoin = useCallback(
    (invite: CloudInviteDeepLink) => {
      setPendingCloudInvite(invite);
      setStationMode("my-station");
      setStationChatVisible("my-station", true);
      if (window.location.pathname !== ROUTES.workStation.code.path) {
        navigate(ROUTES.workStation.code.path);
      }
    },
    [navigate, setPendingCloudInvite, setStationChatVisible, setStationMode]
  );

  const routeToCloudSessionReference = useCallback(
    (reference: CloudSessionReference) => {
      const sessionRowId = `${reference.orgId}:${reference.ownerUserId}:${reference.sourceSessionId}`;
      requestSessionSidebarReveal({
        sessionId: reference.sourceSessionId,
        sidebarItemId: buildCloudRemoteItemId(reference.orgId, sessionRowId),
        cloudOrgId: reference.orgId,
      });
      setStationMode("my-station");
      setStationChatVisible("my-station", true);
      if (window.location.pathname !== ROUTES.workStation.code.path) {
        navigate(ROUTES.workStation.code.path);
      }
    },
    [
      navigate,
      requestSessionSidebarReveal,
      setStationChatVisible,
      setStationMode,
    ]
  );

  // Complete an ORG2 Cloud browser login (design §8): tokens are parsed from
  // the fragment of the RAW deep-link url, persisted to the auth atom, and
  // the profile is enriched fire-and-forget. Returns whether the url was a
  // handled auth callback so callers can dedup-mark it.
  const handleOrg2CloudAuthUrl = useCallback(
    (url: string, expectedCallbackUrl?: string): boolean => {
      const authCallback = parseAuthCallbackFragment(url, expectedCallbackUrl);
      if (!authCallback) return false;
      log("DeepLinkHandler", "Completing ORG2 Cloud sign-in from deep link");
      resetOrgEntitlementCoordinator(store);
      completeOrg2CloudSignIn(authCallback, setOrg2CloudAuth);
      return true;
    },
    [setOrg2CloudAuth, store]
  );

  // Browser sign-in uses a short-lived localhost receiver. Unlike a custom
  // URL scheme, this also works for an unbundled `tauri dev` process on
  // macOS. The listener is app-scoped and idle until the OAuth plugin emits;
  // the loopback server itself is bounded and cleaned up by its coordinator.
  useEffect(() => {
    if (!isTauriReady()) return;
    let disposed = false;

    const setupOAuthListener = async () => {
      try {
        const { onUrl } = await import("@fabianlars/tauri-plugin-oauth");
        const unlisten = await onUrl((url: string) => {
          const pending = readPendingOrg2CloudAuthLoopback();
          if (!pending) return;
          if (handleOrg2CloudAuthUrl(url, pending.callbackUrl)) {
            completePendingOrg2CloudAuthLoopback();
            return;
          }
          if (isOrg2CloudAuthCallback(url, pending.callbackUrl)) {
            // The helper closes after emitting one full callback URL. Do not
            // retain a dead pending flow when its token fragment was invalid.
            completePendingOrg2CloudAuthLoopback();
            logWarn(
              "DeepLinkHandler",
              "ORG2 Cloud loopback callback did not contain a valid session"
            );
          }
        });
        if (disposed) {
          unlisten();
          return;
        }
        oauthUnlistenRef.current = unlisten;
        schedulePendingOrg2CloudAuthLoopbackExpiry();
      } catch (error) {
        logError(
          "DeepLinkHandler",
          "Failed to set up OAuth loopback listener:",
          error
        );
      }
    };

    void setupOAuthListener();
    return () => {
      disposed = true;
      oauthUnlistenRef.current?.();
      oauthUnlistenRef.current = null;
    };
  }, [handleOrg2CloudAuthUrl]);

  // A checkout completed in the system browser: the billing success page
  // navigates to orgii://billing/complete. Re-emit it as the
  // `org2-cloud-billing-complete` event the org panel already listens to.
  // Never dedup-marked — a later checkout re-fires the IDENTICAL url.
  const handleBillingCompleteUrl = useCallback((url: string): boolean => {
    if (!isBillingCompleteDeepLink(url)) return false;
    log("DeepLinkHandler", "Billing checkout completed via deep link");
    void emit("org2-cloud-billing-complete", {});
    return true;
  }, []);

  useEffect(() => {
    // Only run in Tauri environment
    if (!isTauriReady()) {
      return;
    }

    // Prevent duplicate listeners
    if (hasSetupListener.current) {
      return;
    }

    const setupDeepLinkListener = async () => {
      try {
        // Import the deep link plugin
        const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");

        log("DeepLinkHandler", "Setting up deep link listener...");

        // Listen for deep link URLs
        const unlisten = await onOpenUrl((urls: string[]) => {
          for (const url of urls) {
            if (processedDeepLinks.current.has(url)) {
              continue;
            }

            if (handleOrg2CloudAuthUrl(url)) {
              processedDeepLinks.current.add(url);
              break;
            }

            if (handleBillingCompleteUrl(url)) {
              break;
            }

            const cloudShare = parseCloudShareDeepLink(url);
            if (cloudShare) {
              processedDeepLinks.current.add(url);
              trackReArmableShareUrl(
                processedDeepLinks.current,
                reArmableCloudShareUrls.current,
                url
              );
              log(
                "DeepLinkHandler",
                "Routing ORG2 Cloud session share into import flow"
              );
              routeToCloudShare(cloudShare);
              break;
            }

            const cloudInvite = parseCloudInviteDeepLink(url);
            if (cloudInvite) {
              processedDeepLinks.current.add(url);
              log(
                "DeepLinkHandler",
                "Routing ORG2 Cloud invite into join confirmation"
              );
              routeToCloudJoin(cloudInvite);
              break;
            }

            const cloudSessionReference = parseCloudSessionReference(url);
            if (cloudSessionReference) {
              processedDeepLinks.current.add(url);
              log("DeepLinkHandler", "Revealing ORG2 Cloud session reference");
              routeToCloudSessionReference(cloudSessionReference);
              break;
            }

            const parsed = parseDeepLink(url);
            if (!parsed) {
              logWarn("DeepLinkHandler", "Could not parse deep link:", url);
              continue;
            }

            processedDeepLinks.current.add(url);
            log(
              "DeepLinkHandler",
              "Navigating to:",
              parsed.path + parsed.search
            );
            navigate(parsed.path + parsed.search, { replace: true });
            break;
          }
        });

        unlistenRef.current = unlisten;
        hasSetupListener.current = true;
        log("DeepLinkHandler", "Deep link listener ready");
      } catch (error) {
        logError(
          "DeepLinkHandler",
          "Failed to setup deep link listener:",
          error
        );
      }
    };

    setupDeepLinkListener();

    // Cleanup
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
        hasSetupListener.current = false;
      }
    };
  }, [
    navigate,
    routeToCloudJoin,
    routeToCloudSessionReference,
    routeToCloudShare,
    handleOrg2CloudAuthUrl,
    handleBillingCompleteUrl,
  ]);

  // Also check for deep link on initial load (app opened via deep link)
  // This effect should only run ONCE on mount, not on every location change
  useEffect(() => {
    // Only process initial deep link once
    if (hasProcessedInitialDeepLink.current) {
      return;
    }

    const checkInitialDeepLink = async () => {
      if (!isTauriReady()) {
        return;
      }

      try {
        const { getCurrent } = await import("@tauri-apps/plugin-deep-link");
        const initialUrls = await getCurrent();

        if (initialUrls && initialUrls.length > 0) {
          hasProcessedInitialDeepLink.current = true;

          for (const url of initialUrls) {
            if (processedDeepLinks.current.has(url)) {
              continue;
            }

            if (handleOrg2CloudAuthUrl(url)) {
              processedDeepLinks.current.add(url);
              break;
            }

            if (handleBillingCompleteUrl(url)) {
              break;
            }

            const cloudShare = parseCloudShareDeepLink(url);
            if (cloudShare) {
              processedDeepLinks.current.add(url);
              trackReArmableShareUrl(
                processedDeepLinks.current,
                reArmableCloudShareUrls.current,
                url
              );
              log(
                "DeepLinkHandler",
                "Routing initial ORG2 Cloud session share into import flow"
              );
              routeToCloudShare(cloudShare);
              break;
            }

            const cloudInvite = parseCloudInviteDeepLink(url);
            if (cloudInvite) {
              processedDeepLinks.current.add(url);
              log(
                "DeepLinkHandler",
                "Routing initial ORG2 Cloud invite into join confirmation"
              );
              routeToCloudJoin(cloudInvite);
              break;
            }

            const cloudSessionReference = parseCloudSessionReference(url);
            if (cloudSessionReference) {
              processedDeepLinks.current.add(url);
              log(
                "DeepLinkHandler",
                "Revealing initial ORG2 Cloud session reference"
              );
              routeToCloudSessionReference(cloudSessionReference);
              break;
            }

            const parsed = parseDeepLink(url);
            if (!parsed) {
              continue;
            }

            processedDeepLinks.current.add(url);

            if (
              window.location.pathname + window.location.search !==
              parsed.path + parsed.search
            ) {
              log(
                "DeepLinkHandler",
                "Navigating to initial deep link:",
                parsed.path + parsed.search
              );
              navigate(parsed.path + parsed.search, { replace: true });
              break;
            }
          }
        }
      } catch (error) {
        // getCurrent may not be available in all versions of the plugin
        logDebug(
          "DeepLinkHandler",
          "Could not check initial deep link:",
          error
        );
      }
    };

    checkInitialDeepLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // Only run on mount, not on location change
}

export default useDeepLinkHandler;
