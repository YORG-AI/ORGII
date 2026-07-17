/**
 * One org section of the cloud session share dialog: directed member shares
 * + one-shot link shares with revocation, backed by the 0012 share RPCs.
 * Modeled on the self-hosted `useSessionShareOrgSectionModel`, minus the
 * override/visibility pills (the cloud access ladder lives in
 * CloudSyncLevelDialog).
 *
 * Shares are granted at 'replay' level — a deliberate share means "watch
 * this session", and the server's resolve path only honors replay link
 * shares anyway.
 */
import { useAtom, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { Session } from "@src/store/session/sessionAtom/types";
import { copyText } from "@src/util/data/clipboard";

import { org2CloudAccessSettingsAtom } from "../org2CloudAccessSettings";
import { commitRefreshedAuth, org2CloudAuthAtom } from "../org2CloudAuthAtom";
import {
  type CloudOrgMember,
  ensureFreshSession,
  listOrgMembers,
} from "../org2CloudClient";
import { buildCloudSessionShareLink } from "../org2CloudOrgManagement";
import type { Org2CloudOrg } from "../org2CloudOrgsAtom";
import {
  CLOUD_SHARE_LEVEL,
  type CloudSessionShareRecord,
  createCloudSessionShare,
  isCloudShareActive,
  listCloudSessionShares,
  revokeCloudSessionShare,
} from "../org2CloudSharesClient";
import { listOrgSessions } from "../org2CloudSyncClient";
import { org2CloudSyncEngine } from "../org2CloudSyncEngine";
import {
  type CloudReplaySharePolicySnapshot,
  applyCloudReplaySharePolicy,
  assertCloudReplayPublished,
  restoreCloudReplaySharePolicy,
} from "./sharePreparation";

export interface CreatedCloudShareLink {
  shareId: string;
  link: string;
  copied: boolean;
}

/**
 * A one-shot plaintext link is useful only while its matching server grant is
 * active. Revoking another share must leave it alone; revoking this grant must
 * remove it immediately so the dialog cannot offer a known-dead credential.
 */
export function reconcileCreatedLinkAfterRevoke(
  created: CreatedCloudShareLink | null,
  revokedShareId: string
): CreatedCloudShareLink | null {
  return created?.shareId === revokedShareId ? null : created;
}

export function useCloudShareOrgSectionModel({
  session,
  org,
}: {
  session: Session;
  org: Org2CloudOrg;
}) {
  const store = useStore();
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const [shares, setShares] = useState<CloudSessionShareRecord[]>([]);
  const [members, setMembers] = useState<CloudOrgMember[]>([]);
  const [sharesError, setSharesError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedMemberIds, setSelectedMemberIds] = useState<string[]>([]);
  /** Plaintext link of the share created in THIS dialog session — shown once. */
  const [createdLink, setCreatedLink] = useState<CreatedCloudShareLink | null>(
    null
  );

  // Latest auth via ref so token-refresh writes don't recreate callbacks
  // (useCloudSessionActions idiom).
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);
  const selfUserId = auth?.userId ?? null;

  const freshAccessToken = useCallback(async (): Promise<string | null> => {
    const current = authRef.current;
    if (!current) return null;
    const fresh = await ensureFreshSession(current);
    if (!fresh) return null;
    commitRefreshedAuth(setAuth, current, fresh);
    return fresh.accessToken;
  }, [setAuth]);

  const refreshShares = useCallback(async () => {
    const accessToken = await freshAccessToken();
    if (!accessToken) return;
    try {
      const rows = await listCloudSessionShares(
        accessToken,
        org.orgId,
        session.session_id
      );
      setShares(rows.filter((row) => isCloudShareActive(row)));
      setSharesError(null);
    } catch (error) {
      // Most common cause: the session row does not exist server-side yet
      // (never pushed). The dialog stays usable — share actions surface the
      // same error on demand.
      setShares([]);
      setSharesError(error instanceof Error ? error.message : String(error));
    }
  }, [freshAccessToken, org.orgId, session.session_id]);

  useEffect(() => {
    void refreshShares();
  }, [refreshShares]);

  // Roster for the directed multi-select. `[]` on failure (listOrgMembers
  // swallows errors by design) — the picker just renders empty.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const accessToken = await freshAccessToken();
      if (!accessToken) return;
      const roster = await listOrgMembers(accessToken, org.orgId);
      if (!cancelled) setMembers(roster);
    })();
    return () => {
      cancelled = true;
    };
  }, [freshAccessToken, org.orgId]);

  const activeGranteeIds = useMemo(
    () =>
      new Set(
        shares
          .map((share) => share.granteeUserId)
          .filter((id): id is string => Boolean(id))
      ),
    [shares]
  );

  // Active members minus self and minus members already holding a grant.
  const grantableMembers = useMemo(
    () =>
      members.filter(
        (member) =>
          member.status === "active" &&
          member.userId !== selfUserId &&
          !activeGranteeIds.has(member.userId)
      ),
    [activeGranteeIds, members, selfUserId]
  );

  const memberNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const member of members) {
      map.set(member.userId, member.displayName ?? member.userId);
    }
    return map;
  }, [members]);

  const handleToggleMember = useCallback((userId: string) => {
    setSelectedMemberIds((current) =>
      current.includes(userId)
        ? current.filter((id) => id !== userId)
        : [...current, userId]
    );
  }, []);

  const grantableIds = useMemo(
    () => grantableMembers.map((member) => member.userId),
    [grantableMembers]
  );

  // "Everyone" is checked only when every currently-grantable member is
  // selected (empty roster ⇒ not checked). Toggling flips the whole roster:
  // select-all replaces the selection with the exact grantable set (so stale
  // ids from a roster change can't linger), deselect-all clears it.
  const allGrantableSelected =
    grantableIds.length > 0 &&
    grantableIds.every((id) => selectedMemberIds.includes(id));

  const handleToggleSelectAll = useCallback(() => {
    setSelectedMemberIds((current) => {
      const everySelected =
        grantableIds.length > 0 &&
        grantableIds.every((id) => current.includes(id));
      return everySelected ? [] : [...grantableIds];
    });
  }, [grantableIds]);

  /**
   * Make the replay grant truthful before creating it. Background sync is
   * intentionally best-effort/log-only, so an explicit share drains it and
   * then reads the server row back. The returned token is fresh enough for
   * the immediately-following grant RPC.
   */
  const prepareReplayShare = useCallback(async () => {
    const current = store.get(org2CloudAccessSettingsAtom);
    const { next, snapshot } = applyCloudReplaySharePolicy(
      current,
      org.orgId,
      session.session_id
    );
    store.set(org2CloudAccessSettingsAtom, next);
    try {
      org2CloudSyncEngine.resumeOrg(org.orgId);
      await org2CloudSyncEngine.runSyncPassAndWaitForDrain();
      const accessToken = await freshAccessToken();
      if (!accessToken) throw new Error("Not signed in");
      const ownerUserId = authRef.current?.userId;
      if (!ownerUserId) throw new Error("Not signed in");
      const published = await listOrgSessions(accessToken, org.orgId);
      assertCloudReplayPublished(
        published.sessions,
        session.session_id,
        ownerUserId
      );
      return { accessToken, snapshot };
    } catch (error) {
      store.set(org2CloudAccessSettingsAtom, (latest) =>
        restoreCloudReplaySharePolicy(
          latest,
          org.orgId,
          session.session_id,
          snapshot
        )
      );
      org2CloudSyncEngine.resumeOrg(org.orgId);
      await org2CloudSyncEngine.runSyncPassAndWaitForDrain().catch(() => {});
      throw error;
    }
  }, [freshAccessToken, org.orgId, session.session_id, store]);

  const rollbackReplayShare = useCallback(
    async (snapshot: CloudReplaySharePolicySnapshot) => {
      store.set(org2CloudAccessSettingsAtom, (latest) =>
        restoreCloudReplaySharePolicy(
          latest,
          org.orgId,
          session.session_id,
          snapshot
        )
      );
      org2CloudSyncEngine.resumeOrg(org.orgId);
      await org2CloudSyncEngine.runSyncPassAndWaitForDrain();
    },
    [org.orgId, session.session_id, store]
  );

  const handleCreateDirectedShares = useCallback(async () => {
    if (selectedMemberIds.length === 0) return;
    setBusy(true);
    try {
      const selected = [...selectedMemberIds];
      const { accessToken, snapshot } = await prepareReplayShare();
      // One grant per member. A mid-batch failure must not lose the grants
      // that already succeeded, nor re-issue them on retry — keep only the
      // members that still failed selected and reconcile against the server.
      const failed: string[] = [];
      let firstError: string | null = null;
      for (const granteeUserId of selected) {
        try {
          await createCloudSessionShare(accessToken, {
            orgId: org.orgId,
            sessionId: session.session_id,
            level: CLOUD_SHARE_LEVEL.REPLAY,
            granteeUserId,
          });
        } catch (error) {
          failed.push(granteeUserId);
          if (!firstError) {
            firstError = error instanceof Error ? error.message : String(error);
          }
        }
      }
      // No grant survived: restore the exact access override from before the
      // button click. A partial success keeps full replay because those
      // recipients already depend on it.
      if (failed.length === selected.length) {
        await rollbackReplayShare(snapshot);
      }
      setSelectedMemberIds(failed);
      await refreshShares();
      setSharesError(firstError);
    } catch (error) {
      setSharesError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [
    org.orgId,
    prepareReplayShare,
    refreshShares,
    rollbackReplayShare,
    selectedMemberIds,
    session.session_id,
  ]);

  const handleCreateLinkShare = useCallback(async () => {
    setBusy(true);
    let prepared: Awaited<ReturnType<typeof prepareReplayShare>> | null = null;
    let grantCreated = false;
    try {
      prepared = await prepareReplayShare();
      const { shareId, shareToken } = await createCloudSessionShare(
        prepared.accessToken,
        {
          orgId: org.orgId,
          sessionId: session.session_id,
          level: CLOUD_SHARE_LEVEL.REPLAY,
        }
      );
      if (!shareToken) {
        await revokeCloudSessionShare(
          prepared.accessToken,
          org.orgId,
          shareId
        ).catch(() => {});
        throw new Error("Share token missing");
      }
      grantCreated = true;
      const link = buildCloudSessionShareLink(shareToken);
      // The plaintext exists only here. Keep it visible until the dialog
      // closes and let the user copy explicitly; clipboard permissions can
      // reject a background/implicit write, and a visible retry action is
      // essential because the server can never return the token again.
      setCreatedLink({ shareId, link, copied: false });
      setSharesError(null);
      await refreshShares();
    } catch (error) {
      if (prepared && !grantCreated) {
        await rollbackReplayShare(prepared.snapshot).catch(() => {});
      }
      setSharesError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [
    org.orgId,
    prepareReplayShare,
    refreshShares,
    rollbackReplayShare,
    session.session_id,
  ]);

  const handleCopyCreatedLink = useCallback(async () => {
    if (!createdLink) return;
    try {
      // WKWebView may reject the browser clipboard API after the async
      // create-share round trip. The shared helper falls back to the native
      // Tauri command and then a DOM copy, keeping this one-time plaintext
      // usable without weakening its explicit-copy UX.
      await copyText(createdLink.link);
      setCreatedLink((current) =>
        current ? { ...current, copied: true } : current
      );
      setSharesError(null);
    } catch (error) {
      setCreatedLink((current) =>
        current ? { ...current, copied: false } : current
      );
      setSharesError(error instanceof Error ? error.message : String(error));
    }
  }, [createdLink]);

  const handleRevokeShare = useCallback(
    async (shareId: string) => {
      setBusy(true);
      try {
        const accessToken = await freshAccessToken();
        if (!accessToken) throw new Error("Not signed in");
        await revokeCloudSessionShare(accessToken, org.orgId, shareId);
        setCreatedLink((current) =>
          reconcileCreatedLinkAfterRevoke(current, shareId)
        );
        setSharesError(null);
        await refreshShares();
      } catch (error) {
        setSharesError(error instanceof Error ? error.message : String(error));
      } finally {
        setBusy(false);
      }
    },
    [freshAccessToken, org.orgId, refreshShares]
  );

  return {
    shares,
    sharesError,
    busy,
    grantableMembers,
    memberNameById,
    selectedMemberIds,
    createdLink,
    createdLinkCopied: createdLink?.copied ?? false,
    canShare: auth !== null,
    allGrantableSelected,
    handleToggleSelectAll,
    handleToggleMember,
    handleCreateDirectedShares,
    handleCreateLinkShare,
    handleCopyCreatedLink,
    handleRevokeShare,
  };
}
