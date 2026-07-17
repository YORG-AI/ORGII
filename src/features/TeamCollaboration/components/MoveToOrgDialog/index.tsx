/**
 * MoveToOrgDialog — explicitly tag ("move") the owner's own session into a
 * shared org, WITHIN the org's admin-configured repo scopes.
 *
 * Repo scope is the hard governance boundary (server-enforced:
 * cloud_upsert_session_metadata raises ORG2_SCOPE_FORBIDDEN outside it). The
 * tag is a sharing affordance INSIDE that boundary — it makes a scope-matched
 * session visible in the org's shared list without waiting for the access
 * ladder default. Orgs whose scopes don't cover this session's repo (or with
 * no scopes configured, or when the session has no git remote) render
 * disabled with the reason. v1 lists managed cloud orgs; self-hosted orgs
 * join in the next cut (the tag atom + engine already share one namespace).
 */
import Modal from "@/src/scaffold/ModalSystem";
import { useAtom, useAtomValue } from "jotai";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Checkbox from "@src/components/Checkbox";
import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import { DEFAULT_SESSION_ORG_ID } from "@src/store/session";
import type { Session } from "@src/store/session/sessionAtom/types";

import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
} from "../../../Org2Cloud/org2CloudAuthAtom";
import { ensureFreshSession } from "../../../Org2Cloud/org2CloudClient";
import { org2CloudOrgsAtom } from "../../../Org2Cloud/org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "../../../Org2Cloud/org2CloudSyncAtoms";
import { deleteSession } from "../../../Org2Cloud/org2CloudSyncClient";
import { org2CloudSyncEngine } from "../../../Org2Cloud/org2CloudSyncEngine";
import { pickMatchingOrgScope } from "../../collabSyncUtils";
import { isScopeMatchableImportedSession } from "../../importedSessionScopeMatch";
import { resolveShareableScopeKeys } from "../../repoScopeResolver";
import {
  PERSONAL_EXCLUDED_TOKEN,
  cloudOrgIdsForSession,
  cloudOrgToken,
  isSessionExcludedFromPersonal,
  isSessionTaggedToCloudOrg,
  sessionOrgTagsAtom,
  withTag,
  withoutCloudOrgTag,
  withoutTag,
} from "../../sessionOrgTagsAtom";

const log = createLogger("MoveToOrgDialog");

export interface MoveToOrgDialogProps {
  /** The owner's local session; null keeps the dialog closed. */
  session: Session | null;
  onClose: () => void;
}

const MoveToOrgDialog: React.FC<MoveToOrgDialogProps> = ({
  session,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const scopesByOrg = useAtomValue(org2CloudRepoScopesAtom);
  const [tags, setTags] = useAtom(sessionOrgTagsAtom);
  const [busyOrgId, setBusyOrgId] = useState<string | null>(null);
  // undefined = git-remote resolution in flight; null = repo has no remote.
  // Multi-remote: ALL of the checkout's remote keys (origin fork + team
  // upstream + …) — an org scope naming any of them makes the org in-scope.
  const [scopeKeys, setScopeKeys] = useState<string[] | null | undefined>(
    undefined
  );

  const repoPath = session?.repoPath ?? null;
  useEffect(() => {
    if (!repoPath) {
      setScopeKeys(null);
      return undefined;
    }
    setScopeKeys(undefined);
    let cancelled = false;
    void resolveShareableScopeKeys(repoPath).then((keys) => {
      if (!cancelled) setScopeKeys(keys);
    });
    return () => {
      cancelled = true;
    };
  }, [repoPath]);

  const personalUnavailable = session
    ? Boolean(session.orgId) && session.orgId !== DEFAULT_SESSION_ORG_ID
    : false;
  const personalIncluded = session
    ? !personalUnavailable &&
      !isSessionExcludedFromPersonal(tags, session.session_id)
    : true;
  const canLeavePersonal = session
    ? cloudOrgIdsForSession(tags, session.session_id).length > 0
    : false;
  const scopeAutoMatched = session
    ? isScopeMatchableImportedSession(session)
    : false;

  const togglePersonal = useCallback(
    (nextIncluded: boolean) => {
      if (!session) return;
      const sessionId = session.session_id;
      setTags((current) =>
        nextIncluded
          ? withoutTag(current, sessionId, PERSONAL_EXCLUDED_TOKEN)
          : withTag(current, sessionId, PERSONAL_EXCLUDED_TOKEN)
      );
    },
    [session, setTags]
  );

  const toggle = useCallback(
    async (orgId: string, orgName: string, nextChecked: boolean) => {
      if (!session) return;
      const sessionId = session.session_id;
      const token = cloudOrgToken(orgId);
      setBusyOrgId(orgId);
      try {
        if (nextChecked) {
          setTags((current) => withTag(current, sessionId, token));
          // Wait for the targeted push to finish before claiming success. This
          // pass performs metadata + events upsert; the server then emits the
          // org_change_signal that makes teammates revalidate immediately.
          // Previously the fire-and-forget call showed success while the push
          // could still be pending (or fail), which looked like Move to Org
          // had worked locally but remained invisible to every other member.
          await org2CloudSyncEngine.runSyncPassAndWaitForDrain();
          Message.success(t("cloud.moveToOrg.added", { org: orgName }));
        } else {
          // Soft-tombstone on the server BEFORE dropping the local tag: if the
          // delete fails, the tag must stay put rather than orphan a still-live
          // server row that only OTHER members can see (the local user would
          // wrongly believe it was removed, and nothing re-pushes an untagged,
          // unscoped session to self-heal). If the session is still
          // repo-scope-matched, the next pass re-creates it — the invalidate
          // lets that re-upsert clear `deleted_at` instead of looping on
          // ORG2_SESSION_NOT_FOUND (non-backoff) appends.
          if (auth) {
            const fresh = await ensureFreshSession(auth);
            if (!fresh) {
              throw new Error("cloud session token refresh failed");
            }
            commitRefreshedAuth(setAuth, auth, fresh);
            await deleteSession(fresh.accessToken, orgId, sessionId);
            org2CloudSyncEngine.invalidatePushedMetadataHash(orgId, sessionId);
          }
          setTags((current) => withoutCloudOrgTag(current, sessionId, orgId));
          Message.success(t("cloud.moveToOrg.removed", { org: orgName }));
        }
      } catch (error) {
        // Adding is optimistic so the sync engine can see the tag in the same
        // turn. If publication fails, restore the pre-action state instead of
        // leaving a local-only "moved" badge that teammates can never see.
        if (nextChecked) {
          setTags((current) => withoutCloudOrgTag(current, sessionId, orgId));
        }
        log.warn("move-to-org toggle failed", error);
        Message.error(t("cloud.moveToOrg.error"));
      } finally {
        setBusyOrgId(null);
      }
    },
    [session, auth, setAuth, setTags, t]
  );

  return (
    <Modal
      visible={session !== null}
      title={t("cloud.moveToOrg.title")}
      onCancel={onClose}
      footer={null}
      width={460}
    >
      {session ? (
        <div className="flex flex-col gap-3">
          <div className="text-[12px] text-text-3">
            {session.name || session.user_input || session.session_id}
          </div>
          <div className="text-[11px] text-text-3">
            {t("cloud.moveToOrg.hint")}
          </div>
          <div
            className="flex items-center gap-2 rounded-lg border border-border-2 bg-bg-2 px-3 py-2"
            data-testid="session-move-org-option-personal"
          >
            <Checkbox
              checked={personalIncluded}
              disabled={
                personalUnavailable || (personalIncluded && !canLeavePersonal)
              }
              onChange={(next: boolean) => togglePersonal(next)}
            />
            <span className="text-[13px] text-text-1">
              {t("cloud.moveToOrg.personal")}
            </span>
            <span className="ml-auto text-[11px] text-text-3">
              {personalUnavailable
                ? t("cloud.moveToOrg.personalUnavailable")
                : personalIncluded && !canLeavePersonal
                  ? t("cloud.moveToOrg.personalOnlyHome")
                  : t("cloud.moveToOrg.personalBadge")}
            </span>
          </div>
          {cloudOrgs.length === 0 ? (
            <div className="text-[12px] text-text-3">
              {t("cloud.moveToOrg.noOrgs")}
            </div>
          ) : scopeKeys === null ? (
            // Repo has no git remote — nothing can enter any org's scope.
            <div className="text-[12px] text-text-3">
              {t("cloud.moveToOrg.noRemote")}
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {cloudOrgs.map((org) => {
                const checked = isSessionTaggedToCloudOrg(
                  tags,
                  session.session_id,
                  org.orgId
                );
                // Scope is the hard boundary: only in-scope orgs are
                // toggleable (any of the checkout's remotes may match). A
                // stale tag on an out-of-scope org stays visible (checked +
                // disabled) — the sync engine retracts and drops it on its
                // next pass. undefined scopeKeys = resolution in flight,
                // keep the row disabled meanwhile.
                const inScope =
                  scopeKeys !== undefined &&
                  pickMatchingOrgScope(scopeKeys, scopesByOrg[org.orgId]) !==
                    null;
                const disabled = busyOrgId === org.orgId || !inScope;
                return (
                  <div
                    key={org.orgId}
                    className="flex items-center gap-2 rounded-lg border border-border-2 bg-bg-2 px-3 py-2"
                    data-testid={`session-move-org-option-cloud:${org.orgId}`}
                  >
                    <Checkbox
                      checked={checked}
                      disabled={disabled}
                      onChange={(next: boolean) =>
                        void toggle(org.orgId, org.name, next)
                      }
                    />
                    <span
                      className={
                        inScope
                          ? "text-[13px] text-text-1"
                          : "text-[13px] text-text-3"
                      }
                    >
                      {org.name}
                    </span>
                    <span className="ml-auto text-[11px] text-text-3">
                      {scopeKeys === undefined
                        ? t("cloud.moveToOrg.scopeResolving")
                        : inScope
                          ? scopeAutoMatched && !checked
                            ? t("cloud.moveToOrg.autoInScope")
                            : t("cloud.moveToOrg.cloudBadge")
                          : (scopesByOrg[org.orgId]?.length ?? 0) === 0
                            ? t("cloud.moveToOrg.noScopes")
                            : t("cloud.moveToOrg.outOfScope")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
};

export default MoveToOrgDialog;
