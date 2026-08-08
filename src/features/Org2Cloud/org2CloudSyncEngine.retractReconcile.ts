/**
 * Retract-only reconcile for orgs the user is NOT looking at (P2).
 *
 * Full session passes run for the active workspace and for background-upload-
 * enabled orgs. A session that loses admission in any remaining
 * inactive org would otherwise stay published until the user happens to
 * reopen it, which may be never; a background-upload org can also fall out of
 * the main target set after its final scope or tag disappears. This module
 * closes both holes with the cheapest sound sweep: once per engine run, for
 * each NON-ACTIVE org where THIS client holds persisted push markers, re-run
 * the SAME admission decision (`decidePushAdmission`) and the SAME server-
 * confirmed scope boundary over the marked sessions, retracting the rows this
 * client can prove it pushed. No pushes, no replay hydration, no listing RPC
 * — per org this costs one scope fetch (TTL-shared with the main pass) plus
 * local work.
 *
 * Safety rails carried over verbatim from the main pass:
 * - only rows with LOCAL push markers are touched — never someone else's;
 * - out-of-scope retracts require scopes CONFIRMED from the server this
 *   run (a stale mirror cannot prove "out of scope");
 * - sessions with scope resolution in flight are skipped, not judged;
 * - a locally-ABSENT session is left to the vanished-session sweep and its
 *   two-strike confirmation — absence is not authority here.
 */
import { createLogger } from "@src/hooks/logger";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";

import { getSessionForkedFrom } from "../TeamCollaboration/forkSession";
import { resolveMatchingOrgRepoScope } from "../TeamCollaboration/repoScopeResolver";
import {
  isSessionTaggedToCloudOrg,
  sessionOrgTagsAtom,
  withoutCloudOrgTag,
} from "../TeamCollaboration/sessionOrgTagsAtom";
import {
  type CloudOrgAccessSettings,
  hasExplicitCloudShareIntent,
} from "./org2CloudAccessSettings";
import { buildCloudOrgSelectorValue } from "./org2CloudOrgsAtom";
import { decidePushAdmission } from "./org2CloudPushAdmission";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
} from "./org2CloudSyncAtoms";
import { getSessionScopeKeys } from "./org2CloudSyncEngine.repoScopeSync";
import type { CloudStore } from "./org2CloudSyncLifecycle";

const log = createLogger("Org2CloudRetractReconcile");

export interface RetractReconcileDeps {
  store: CloudStore;
  accessByOrg: Record<string, CloudOrgAccessSettings | undefined>;
  wasCloudPushed: (orgId: string, sessionId: string) => boolean;
  retractSession: (orgId: string, sessionId: string) => Promise<void>;
  hasServerConfirmedScopes: (orgId: string) => boolean;
  isCurrentGeneration: () => boolean;
}

/** Org ids where THIS client holds any persisted push marker. */
export function orgsWithLocalPushMarkers(
  cursors: Record<string, unknown>,
  pushedMetadata: Record<string, unknown>
): Set<string> {
  const orgIds = new Set<string>();
  for (const key of [...Object.keys(cursors), ...Object.keys(pushedMetadata)]) {
    const separator = key.indexOf(":");
    if (separator > 0) orgIds.add(key.slice(0, separator));
  }
  return orgIds;
}

/** Marked session ids for one org, from both marker atoms. */
export function markedSessionIdsForOrg(
  orgId: string,
  cursors: Record<string, unknown>,
  pushedMetadata: Record<string, unknown>
): Set<string> {
  const prefix = `${orgId}:`;
  const ids = new Set<string>();
  for (const key of [...Object.keys(cursors), ...Object.keys(pushedMetadata)]) {
    if (key.startsWith(prefix)) ids.add(key.slice(prefix.length));
  }
  return ids;
}

export async function reconcileOrgRetracts(
  deps: RetractReconcileDeps,
  orgId: string
): Promise<void> {
  const { store } = deps;
  const cursors = store.get(org2CloudPushCursorsAtom);
  const pushedMetadata = store.get(org2CloudPushedMetadataAtom);
  const marked = markedSessionIdsForOrg(orgId, cursors, pushedMetadata);
  if (marked.size === 0) return;

  const sessions = store.get(sessionsAtom);
  const sessionById = new Map(sessions.map((s) => [s.session_id, s]));
  const scopes = store.get(org2CloudRepoScopesAtom)[orgId] ?? [];

  for (const sessionId of marked) {
    if (!deps.isCurrentGeneration()) return;
    const session = sessionById.get(sessionId);
    // Locally absent: the vanished-session sweep owns that verdict (with
    // its two-strike confirmation). Absence here proves nothing.
    if (!session) continue;
    if (!deps.wasCloudPushed(orgId, sessionId)) continue;

    const forkedFrom = getSessionForkedFrom(session);
    const tagged = isSessionTaggedToCloudOrg(
      store.get(sessionOrgTagsAtom),
      sessionId,
      orgId
    );
    const admission = decidePushAdmission({
      orgId,
      session,
      forkedFrom,
      tagged,
      ownedByOrg: session.orgId === buildCloudOrgSelectorValue(orgId),
      shareIntent: hasExplicitCloudShareIntent(
        deps.accessByOrg[orgId],
        sessionId
      ),
    });

    if (!admission.admitted) {
      try {
        log.info(
          `reconcile retract [${admission.denial}]: session ${sessionId} org ${orgId}`
        );
        await deps.retractSession(orgId, sessionId);
      } catch (error) {
        log.warn(`reconcile retract failed for ${sessionId}:`, error);
      }
      continue;
    }

    const scopeKeys = getSessionScopeKeys(session);
    if (scopeKeys === undefined) continue;
    const matchedScope = await resolveMatchingOrgRepoScope(scopeKeys, scopes);
    if (matchedScope !== null) continue;
    if (!deps.hasServerConfirmedScopes(orgId)) {
      log.info(
        `reconcile scope check deferred: session ${sessionId} org ${orgId}`
      );
      continue;
    }
    try {
      log.info(
        `reconcile retract [out-of-scope (no matching org scope)]: session ${sessionId} org ${orgId}`
      );
      await deps.retractSession(orgId, sessionId);
    } catch (error) {
      log.warn(`reconcile retract failed for ${sessionId}:`, error);
      continue;
    }
    if (tagged) {
      store.set(sessionOrgTagsAtom, (current) =>
        withoutCloudOrgTag(current, sessionId, orgId)
      );
      log.info(
        `reconcile dropped out-of-scope org tag: session ${sessionId} → org ${orgId}`
      );
    }
  }
}
