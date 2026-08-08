/**
 * Hook half of `openCloudSessionReference`: applies the admission decision,
 * then publishes the reveal request the Team Sessions section consumes.
 *
 * `autoReplay` distinguishes the two entry points. An in-app chip means
 * "take me to this transcript", so it opens the session. An OS deep link
 * arrives from outside the app and stays reveal-only, so an external click
 * never starts a replay download on its own.
 *
 * Auth, roster, and copy are read at CLICK time through the store and the
 * i18n singleton rather than through subscriptions: the deep-link handler
 * keeps this callback in the dep array of the effect that registers the OS
 * listener, and a callback that changed identity on every roster write
 * would tear that listener down and re-register it once per sync pass,
 * leaving a window where an incoming link is dropped.
 */
import { useSetAtom, useStore } from "jotai";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

import Message from "@src/components/Message";
import { ROUTES } from "@src/config/routes";
import i18n from "@src/i18n";
import { activeStationChatVisibleAtom } from "@src/store/ui/chatPanelAtom";
import { requestSessionSidebarRevealAtom } from "@src/store/ui/sidebarAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";

import { showCloudReferenceOpeningToast } from "./cloudReferenceOpeningToast";
import { buildCloudRemoteItemId } from "./cloudRemoteItemId";
import type { CloudSessionReference } from "./cloudSessionReference";
import {
  CLOUD_REFERENCE_REFUSAL,
  cloudReferenceRowId,
  decideCloudReferenceAdmission,
} from "./openCloudSessionReference";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { org2CloudOrgsAtom } from "./org2CloudOrgsAtom";
import { REFUSAL_MESSAGE_DURATION_MS } from "./referenceRefusalMessage";

/**
 * Returns whether the reference was admitted. The deep-link handler dedups
 * processed URLs for the app's lifetime, so it must only mark a URL once
 * this said yes: a link clicked while signed out would otherwise be burned
 * and never work again in that run, even after signing in.
 */
export type OpenCloudSessionReference = (
  reference: CloudSessionReference,
  options?: { autoReplay?: boolean }
) => boolean;

export function useOpenCloudSessionReference(): OpenCloudSessionReference {
  const store = useStore();
  const navigate = useNavigate();
  const requestSessionSidebarReveal = useSetAtom(
    requestSessionSidebarRevealAtom
  );
  const setStationMode = useSetAtom(stationModeAtom);
  const setStationChatVisible = useSetAtom(activeStationChatVisibleAtom);

  return useCallback(
    (reference, options) => {
      const admission = decideCloudReferenceAdmission({
        orgId: reference.orgId,
        signedIn: Boolean(store.get(org2CloudAuthAtom)),
        orgs: store.get(org2CloudOrgsAtom),
      });
      if (!admission.admitted) {
        // A refusal is the ONLY thing that happens on this click, so it has
        // to outlast the 1s default: a message nobody can read makes a
        // working refusal indistinguishable from a broken chip.
        Message.error(
          i18n.t(
            admission.refusal === CLOUD_REFERENCE_REFUSAL.SIGNED_OUT
              ? "navigation:cloud.sessionRef.signInRequired"
              : "navigation:cloud.sessionRef.notMember"
          ),
          { duration: REFUSAL_MESSAGE_DURATION_MS, closable: true }
        );
        return false;
      }

      requestSessionSidebarReveal({
        sessionId: reference.sourceSessionId,
        sidebarItemId: buildCloudRemoteItemId(
          reference.orgId,
          cloudReferenceRowId(reference)
        ),
        cloudOrgId: reference.orgId,
        autoReplay: options?.autoReplay ?? false,
      });
      if (options?.autoReplay) {
        // The pre-phase (org switch, listing fetch, freshness probe) used to
        // be completely silent — indistinguishable from a dead chip.
        showCloudReferenceOpeningToast();
      }
      setStationMode("my-station");
      setStationChatVisible("my-station", true);
      if (window.location.pathname !== ROUTES.workStation.code.path) {
        navigate(ROUTES.workStation.code.path);
      }
      return true;
    },
    [
      navigate,
      requestSessionSidebarReveal,
      setStationChatVisible,
      setStationMode,
      store,
    ]
  );
}
