/**
 * "Copy URL" for a LOCAL session row.
 *
 * The teammate rows in Team Sessions have always offered this, because
 * their row data already carries the `(org, owner, session)` tuple a
 * reference needs. Your own sessions are the ones you most often want a
 * reviewer to look at, so they need it too — but a local row does not carry
 * that tuple, and inventing one produces a link that resolves for nobody.
 *
 * The org is therefore resolved (see `resolveSessionReferenceOrg`) rather
 * than assumed, and the menu item is hidden entirely for a session that was
 * never published to a cloud org.
 */
import { useAtomValue, useStore } from "jotai";
import { useCallback } from "react";

import Message from "@src/components/Message";
import i18n from "@src/i18n";
import type { Session } from "@src/store/session";
import { copyText } from "@src/util/data/clipboard";

import { buildCloudSessionReference } from "./cloudSessionReference";
import { org2CloudAuthAtom } from "./org2CloudAuthAtom";
import { sidebarActiveCloudOrgIdAtom } from "./org2CloudOrgsAtom";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
} from "./org2CloudSyncAtoms";
import { REFUSAL_MESSAGE_DURATION_MS } from "./referenceRefusalMessage";
import {
  SESSION_REFERENCE_ORG,
  publishedOrgIdsForSession,
  resolveSessionReferenceOrg,
} from "./resolveSessionReferenceOrg";

export interface CopySessionReferenceResult {
  isCopyReferenceEligible: (session: Session) => boolean;
  handleCopyReference: (session: Session) => void;
  copyReferenceLabel: string;
}

export function useCopySessionReference(): CopySessionReferenceResult {
  const store = useStore();
  // Subscribed, not read at click time: the menu's visibility depends on
  // these, so a session that finishes its first push must gain the item
  // without needing a remount.
  const cursors = useAtomValue(org2CloudPushCursorsAtom);
  const pushedMetadata = useAtomValue(org2CloudPushedMetadataAtom);
  const auth = useAtomValue(org2CloudAuthAtom);

  const isCopyReferenceEligible = useCallback(
    (session: Session) =>
      Boolean(auth?.userId) &&
      publishedOrgIdsForSession(session.session_id, cursors, pushedMetadata)
        .length > 0,
    [auth, cursors, pushedMetadata]
  );

  const handleCopyReference = useCallback(
    (session: Session) => {
      const userId = store.get(org2CloudAuthAtom)?.userId;
      if (!userId) return;
      const resolution = resolveSessionReferenceOrg({
        publishedOrgIds: publishedOrgIdsForSession(
          session.session_id,
          store.get(org2CloudPushCursorsAtom),
          store.get(org2CloudPushedMetadataAtom)
        ),
        activeCloudOrgId: store.get(sidebarActiveCloudOrgIdAtom),
      });
      if (resolution.kind === SESSION_REFERENCE_ORG.UNPUBLISHED) {
        Message.error(i18n.t("navigation:cloud.sessionRef.notPublished"), {
          duration: REFUSAL_MESSAGE_DURATION_MS,
          closable: true,
        });
        return;
      }
      if (resolution.kind === SESSION_REFERENCE_ORG.CHOOSE) {
        // Ambiguous only when the session spans orgs AND the current scope
        // picks none of them. Naming the orgs beats silently choosing one.
        Message.warning(i18n.t("navigation:cloud.sessionRef.chooseOrg"), {
          duration: REFUSAL_MESSAGE_DURATION_MS,
          closable: true,
        });
        return;
      }
      void copyText(
        buildCloudSessionReference({
          orgId: resolution.orgId,
          ownerUserId: userId,
          sourceSessionId: session.session_id,
        })
      )
        .then(() => Message.success(i18n.t("common:actions.copied")))
        .catch(() =>
          Message.error(i18n.t("common:actions.copyFailed"), {
            duration: REFUSAL_MESSAGE_DURATION_MS,
            closable: true,
          })
        );
    },
    [store]
  );

  return {
    isCopyReferenceEligible,
    handleCopyReference,
    copyReferenceLabel: i18n.t("navigation:cloud.sidebar.copyUrl"),
  };
}
