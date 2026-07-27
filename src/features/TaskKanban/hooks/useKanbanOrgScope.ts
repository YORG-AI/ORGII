import { useAtomValue } from "jotai";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { KanbanTaskCreator } from "@src/features/KanbanBoard/types";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { parseCloudOrgSelectorValue } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import {
  buildSessionOrgFilterIds,
  sessionMatchesOrgFilter,
} from "@src/features/Organizations/sessionOrgScope";
import { sidebarSelectedOrgIdAtom } from "@src/features/Organizations/sidebarOrgScopeAtom";
import { collectScopeMatchedImportedSessionIds } from "@src/features/TeamCollaboration/importedSessionScopeMatch";
import { useShareableScopeKeyVersion } from "@src/features/TeamCollaboration/repoScopeResolver";
import {
  cloudOrgIdsForSession,
  isSessionExcludedFromPersonal,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import { DEFAULT_SESSION_ORG_ID, type Session } from "@src/store/session";
import { userDisplayNameAtom } from "@src/store/ui/uiAtom";
import { userAtom } from "@src/store/user";

export interface KanbanOrgScope {
  selectedOrgId: string;
  selectedOrgIds: ReadonlySet<string>;
  /** Bare managed-cloud org id when the selected scope is an ORG2 Cloud org. */
  cloudOrgId?: string;
  /** Signed-in cloud identity used to distinguish own and teammate rows. */
  cloudViewerUserId?: string;
  extraSessionIds?: ReadonlySet<string>;
  excludedSessionIds?: ReadonlySet<string>;
  currentCreator: KanbanTaskCreator;
}

export function sessionMatchesKanbanOrgScope(
  session: Pick<Session, "session_id" | "orgId">,
  scope: KanbanOrgScope | undefined
): boolean {
  if (!scope) return true;
  if (scope.excludedSessionIds?.has(session.session_id)) return false;
  return (
    sessionMatchesOrgFilter(session, scope.selectedOrgIds) ||
    Boolean(scope.extraSessionIds?.has(session.session_id))
  );
}

export function resolveKanbanTaskCreator(
  session: Pick<Session, "importedFrom">,
  scope: KanbanOrgScope | undefined
): KanbanTaskCreator | undefined {
  if (!scope || scope.selectedOrgId === DEFAULT_SESSION_ORG_ID) {
    return undefined;
  }

  const importedFrom = session.importedFrom;
  if (importedFrom) {
    const name = importedFrom.ownerDisplayName?.trim();
    return {
      id: importedFrom.ownerMemberId,
      name: name || importedFrom.ownerMemberId,
      ...(importedFrom.ownerAvatarUrl
        ? { avatarUrl: importedFrom.ownerAvatarUrl }
        : {}),
    };
  }

  return scope.currentCreator;
}

/**
 * Resolve the Workstation sidebar's organization selection into the exact
 * session boundary consumed by every Task Kanban view. The repo-scope cache
 * subscription is mounted only with Task Kanban and cleans up on unmount.
 */
export function useKanbanOrgScope(
  sessions: readonly Session[],
  enabled: boolean
): KanbanOrgScope | undefined {
  const { t } = useTranslation("common");
  const selectedOrgId = useAtomValue(sidebarSelectedOrgIdAtom);
  const tags = useAtomValue(sessionOrgTagsAtom);
  const repoScopesByOrg = useAtomValue(org2CloudRepoScopesAtom);
  const auth = useAtomValue(org2CloudAuthAtom);
  const user = useAtomValue(userAtom);
  const userDisplayName = useAtomValue(userDisplayNameAtom);
  const scopeKeyVersion = useShareableScopeKeyVersion();
  const authUserId = auth?.userId;
  const authDisplayName = auth?.profile?.displayName;
  const authPrimaryEmail = auth?.profile?.primaryEmail;
  const authAvatarUrl = auth?.profile?.avatarUrl;

  const selectedOrgIds = useMemo(
    () => buildSessionOrgFilterIds(selectedOrgId),
    [selectedOrgId]
  );
  const cloudOrgId = parseCloudOrgSelectorValue(selectedOrgId);

  const extraSessionIds = useMemo(() => {
    if (!enabled || !cloudOrgId) return undefined;
    const ids = collectScopeMatchedImportedSessionIds(
      sessions,
      repoScopesByOrg[cloudOrgId]
    );
    void scopeKeyVersion;
    for (const sessionId of Object.keys(tags)) {
      if (cloudOrgIdsForSession(tags, sessionId).includes(cloudOrgId)) {
        ids.add(sessionId);
      }
    }
    return ids.size > 0 ? ids : undefined;
  }, [cloudOrgId, enabled, repoScopesByOrg, scopeKeyVersion, sessions, tags]);

  const excludedSessionIds = useMemo(() => {
    if (!enabled || selectedOrgId !== DEFAULT_SESSION_ORG_ID) return undefined;
    const ids = new Set<string>();
    for (const sessionId of Object.keys(tags)) {
      if (isSessionExcludedFromPersonal(tags, sessionId)) ids.add(sessionId);
    }
    return ids.size > 0 ? ids : undefined;
  }, [enabled, selectedOrgId, tags]);

  const currentCreator = useMemo<KanbanTaskCreator>(() => {
    const name =
      authDisplayName?.trim() ||
      userDisplayName.trim() ||
      user.name.trim() ||
      user.git_user_name.trim() ||
      authPrimaryEmail?.trim() ||
      t("terminology.you");
    const avatarUrl =
      authAvatarUrl || user.profile_image_url || user.picture || undefined;
    return {
      id: authUserId || user.uuid || user.git_user_email || "current-user",
      name,
      ...(avatarUrl ? { avatarUrl } : {}),
    };
  }, [
    authAvatarUrl,
    authDisplayName,
    authPrimaryEmail,
    authUserId,
    t,
    user,
    userDisplayName,
  ]);

  return useMemo(
    () =>
      enabled
        ? {
            selectedOrgId,
            selectedOrgIds,
            ...(cloudOrgId ? { cloudOrgId } : {}),
            ...(authUserId ? { cloudViewerUserId: authUserId } : {}),
            extraSessionIds,
            excludedSessionIds,
            currentCreator,
          }
        : undefined,
    [
      currentCreator,
      cloudOrgId,
      authUserId,
      enabled,
      excludedSessionIds,
      extraSessionIds,
      selectedOrgId,
      selectedOrgIds,
    ]
  );
}
