import { useAtom, useAtomValue, useStore } from "jotai";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  getOrgSharingFloor,
  org2CloudSharingFloorAtom,
} from "@src/features/Org2Cloud/org2CloudAccessSettings";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  type CloudEntitlementState,
  type CloudOrgMember,
  ensureFreshSession,
  getEntitlementState,
} from "@src/features/Org2Cloud/org2CloudClient";
import { broadcastOrgControlChangedToPeers } from "@src/features/Org2Cloud/org2CloudControlBus";
import { isFetchTransportError } from "@src/features/Org2Cloud/org2CloudFetchRetry";
import { loadCloudOrgMembers } from "@src/features/Org2Cloud/org2CloudMembersCoordinator";
import {
  org2CloudRosterRealtimeConnectedAtom,
  org2CloudRosterVersionAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import {
  deriveScopeQuotaView,
  parseScopeCooldownFreesAt,
} from "@src/features/Org2Cloud/org2CloudScopeQuota";
import { org2CloudRepoScopesAtom } from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import {
  type CloudOrgScopeState,
  getOrgRepoScopes,
  isOrg2SyncErrorCode,
  setOrgRepoScopes,
  setOrgSharingFloor,
} from "@src/features/Org2Cloud/org2CloudSyncClient";
import { org2CloudSyncEngine } from "@src/features/Org2Cloud/org2CloudSyncEngine";
import { createLogger } from "@src/hooks/logger";
import { useTauriListen } from "@src/hooks/platform/useTauriListen";
import {
  COLLAB_SESSION_ACCESS_MODE,
  type CollabSessionAccessMode,
} from "@src/store/collaboration/types";
import { isTauriReady } from "@src/util/platform/tauri/init";

import type { SelectValue } from "./cloudOrgPanelTypes";

const log = createLogger("CloudOrgPanelView");
/** Stable reference for the identity-mismatch window (no re-render churn). */
const NO_VISIBLE_MEMBERS: CloudOrgMember[] = [];

type FetchState = "loading" | "ready" | "error";

/**
 * Owns the cloud reads and the repo-scope/access policy mutations for the
 * selected org. Rendering and target navigation stay in focused components.
 */
export function useCloudOrgPanelState(orgId: string) {
  const { t } = useTranslation("navigation");
  const store = useStore();
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const rosterVersionByOrg = useAtomValue(org2CloudRosterVersionAtom);
  const rosterRealtimeConnectedByOrg = useAtomValue(
    org2CloudRosterRealtimeConnectedAtom
  );
  const [entitlement, setEntitlement] = useState<CloudEntitlementState | null>(
    null
  );
  const [members, setMembers] = useState<CloudOrgMember[]>([]);
  const [membersIdentityKey, setMembersIdentityKey] = useState<string | null>(
    null
  );
  const membersRequestEpochRef = useRef(0);
  const [fetchState, setFetchState] = useState<FetchState>("loading");
  const [repoScopesByOrg, setRepoScopesByOrg] = useAtom(
    org2CloudRepoScopesAtom
  );
  const [floorByOrg, setFloorByOrg] = useAtom(org2CloudSharingFloorAtom);
  const [savingFloor, setSavingFloor] = useState(false);
  const [floorError, setFloorError] = useState<string | null>(null);
  const [scopeState, setScopeState] = useState<CloudOrgScopeState | null>(null);
  const [savingScopes, setSavingScopes] = useState(false);
  const [scopesSaved, setScopesSaved] = useState(false);
  const [scopesError, setScopesError] = useState<string | null>(null);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const [membersRecoveryVersion, setMembersRecoveryVersion] = useState(0);

  useTauriListen(
    "org2-cloud-billing-complete",
    () => {
      log.info("billing checkout completed — refreshing org panel");
      setRefreshNonce((nonce) => nonce + 1);
    },
    { enabled: isTauriReady() }
  );

  const rosterVersion = rosterVersionByOrg[orgId] ?? 0;
  const rosterRealtimeConnected = rosterRealtimeConnectedByOrg[orgId] === true;
  const rosterVersionRef = useRef(rosterVersion);
  rosterVersionRef.current = rosterVersion;
  const signedIn = Boolean(auth);
  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const visibleMembers =
    membersIdentityKey === authIdentityKey ? members : NO_VISIBLE_MEMBERS;
  const currentUserId = auth?.userId ?? null;
  const savedScopes = useMemo(
    () => repoScopesByOrg[orgId] ?? [],
    [repoScopesByOrg, orgId]
  );
  const [draftScopes, setDraftScopes] = useState<string[]>(savedScopes);

  useEffect(() => {
    setDraftScopes(store.get(org2CloudRepoScopesAtom)[orgId] ?? []);
    setScopeState(null);
    setScopesSaved(false);
    setScopesError(null);
    // The org id intentionally owns draft reseeding; atom hydration should
    // not overwrite an admin's in-flight edits.
  }, [orgId, store]);

  const scopesDirty = useMemo(
    () =>
      savedScopes.length !== draftScopes.length ||
      savedScopes.some((scope, index) => scope !== draftScopes[index]),
    [savedScopes, draftScopes]
  );
  const scopesDirtyRef = useRef(scopesDirty);
  useEffect(() => {
    scopesDirtyRef.current = scopesDirty;
  }, [scopesDirty]);

  const scopeQuota = useMemo(
    () =>
      scopeState
        ? deriveScopeQuotaView({ scopeState, draft: draftScopes })
        : null,
    [scopeState, draftScopes]
  );

  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  useEffect(() => {
    if (!signedIn) return undefined;
    const recoverWhenInteractive = () => {
      if (document.visibilityState !== "hidden" && !rosterRealtimeConnected) {
        setMembersRecoveryVersion((version) => version + 1);
      }
    };
    window.addEventListener("focus", recoverWhenInteractive);
    document.addEventListener("visibilitychange", recoverWhenInteractive);
    return () => {
      window.removeEventListener("focus", recoverWhenInteractive);
      document.removeEventListener("visibilitychange", recoverWhenInteractive);
    };
  }, [signedIn, authIdentityKey, orgId, rosterRealtimeConnected]);

  useEffect(() => {
    if (!signedIn) return;
    let cancelled = false;
    void (async () => {
      setFetchState("loading");
      const current = authRef.current;
      if (!current) {
        if (!cancelled) setFetchState("error");
        return;
      }
      const fresh = await ensureFreshSession(current);
      if (!fresh) {
        log.warn("cloud org panel fetch skipped: token refresh failed");
        if (!cancelled) setFetchState("error");
        return;
      }
      commitRefreshedAuth(setAuth, current, fresh);
      const currentIdentityKey = org2CloudAuthIdentityKey(current);
      const membersRequestEpoch = ++membersRequestEpochRef.current;
      const [entitlementResult, membersLoadResult, scopeStateResult] =
        await Promise.all([
          getEntitlementState(fresh.accessToken, orgId),
          loadCloudOrgMembers(store, fresh, orgId, rosterVersionRef.current),
          getOrgRepoScopes(fresh.accessToken, orgId).catch((error: unknown) => {
            log.warn("cloud_get_org_repo_scopes failed:", error);
            return null;
          }),
        ]);
      const latestAuth = authRef.current;
      if (
        cancelled ||
        !latestAuth ||
        org2CloudAuthIdentityKey(latestAuth) !== currentIdentityKey
      ) {
        return;
      }
      const membersResult = membersLoadResult?.members ?? [];
      setEntitlement(entitlementResult);
      if (entitlementResult) {
        const nextFloor =
          entitlementResult.orgSharingFloor ?? COLLAB_SESSION_ACCESS_MODE.OFF;
        setFloorByOrg((previous) =>
          previous[orgId] === nextFloor
            ? previous
            : { ...previous, [orgId]: nextFloor }
        );
      }
      if (membersRequestEpochRef.current === membersRequestEpoch) {
        setMembers(membersResult);
        setMembersIdentityKey(currentIdentityKey);
      }
      if (scopeStateResult) {
        setScopeState(scopeStateResult);
        setRepoScopesByOrg((previous) => ({
          ...previous,
          [orgId]: scopeStateResult.repoScopes,
        }));
        if (!scopesDirtyRef.current) {
          setDraftScopes(scopeStateResult.repoScopes);
        }
      }
      setFetchState(
        entitlementResult || membersResult.length > 0 ? "ready" : "error"
      );
    })();
    return () => {
      cancelled = true;
    };
  }, [
    orgId,
    signedIn,
    authIdentityKey,
    refreshNonce,
    setAuth,
    setRepoScopesByOrg,
    setFloorByOrg,
    store,
  ]);

  const observedRosterVersionRef = useRef(rosterVersion);
  const observedMembersRecoveryVersionRef = useRef(membersRecoveryVersion);
  useEffect(() => {
    observedRosterVersionRef.current = rosterVersion;
    observedMembersRecoveryVersionRef.current = membersRecoveryVersion;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- org switches snapshot the current counters; subsequent counter changes are consumed by the member-only fetch effect below
  }, [orgId]);
  useEffect(() => {
    if (!signedIn) return;
    if (document.visibilityState === "hidden") return;
    const rosterChanged = observedRosterVersionRef.current !== rosterVersion;
    const recoveryRequested =
      observedMembersRecoveryVersionRef.current !== membersRecoveryVersion;
    if (!rosterChanged && !recoveryRequested) return;
    observedRosterVersionRef.current = rosterVersion;
    observedMembersRecoveryVersionRef.current = membersRecoveryVersion;
    let cancelled = false;
    const membersRequestEpoch = ++membersRequestEpochRef.current;
    void (async () => {
      const current = authRef.current;
      if (!current) return;
      const currentIdentityKey = org2CloudAuthIdentityKey(current);
      const loaded = await loadCloudOrgMembers(
        store,
        current,
        orgId,
        rosterVersion,
        { force: recoveryRequested }
      );
      if (
        !loaded ||
        cancelled ||
        membersRequestEpochRef.current !== membersRequestEpoch ||
        !authRef.current ||
        org2CloudAuthIdentityKey(authRef.current) !== currentIdentityKey
      ) {
        return;
      }
      commitRefreshedAuth(setAuth, current, loaded.auth);
      setMembers(loaded.members);
      setMembersIdentityKey(currentIdentityKey);
    })().catch((error: unknown) => {
      log.warn("cloud org roster refresh failed:", error);
    });
    return () => {
      cancelled = true;
    };
  }, [
    orgId,
    signedIn,
    authIdentityKey,
    rosterVersion,
    membersRecoveryVersion,
    setAuth,
    store,
  ]);

  const refreshScopeState = async (accessToken: string): Promise<void> => {
    try {
      const state = await getOrgRepoScopes(accessToken, orgId);
      setScopeState(state);
      setRepoScopesByOrg((previous) => ({
        ...previous,
        [orgId]: state.repoScopes,
      }));
    } catch (error) {
      log.warn("cloud_get_org_repo_scopes refresh failed:", error);
    }
  };

  const handleSaveScopes = async (): Promise<void> => {
    const current = authRef.current;
    if (!current) return;
    setSavingScopes(true);
    setScopesError(null);
    setScopesSaved(false);
    let freshToken: string | null = null;
    try {
      const fresh = await ensureFreshSession(current);
      if (!fresh) throw new Error(t("cloud.orgPanel.loadError"));
      commitRefreshedAuth(setAuth, current, fresh);
      freshToken = fresh.accessToken;
      await setOrgRepoScopes(fresh.accessToken, orgId, draftScopes);
      setRepoScopesByOrg((previous) => ({
        ...previous,
        [orgId]: draftScopes,
      }));
      setScopesSaved(true);
      broadcastOrgControlChangedToPeers(orgId, "scopes");
      await refreshScopeState(fresh.accessToken);
    } catch (error) {
      if (isOrg2SyncErrorCode(error, "ORG2_SCOPE_COOLDOWN")) {
        const freesAt = parseScopeCooldownFreesAt(
          error instanceof Error ? error.message : ""
        );
        setScopesError(
          freesAt
            ? t("cloud.orgPanel.scopeCooldownError", {
                date: freesAt.toLocaleDateString(),
              })
            : t("cloud.orgPanel.scopeCooldownErrorNoDate")
        );
        if (freshToken) await refreshScopeState(freshToken);
        return;
      }
      setScopesError(
        isFetchTransportError(error)
          ? t("cloud.orgManagement.errors.network")
          : error instanceof Error
            ? error.message
            : String(error)
      );
    } finally {
      setSavingScopes(false);
    }
  };

  const orgFloor = getOrgSharingFloor(floorByOrg, orgId);
  const handleFloorChange = async (value: SelectValue): Promise<void> => {
    const next = value as CollabSessionAccessMode;
    const previous = orgFloor;
    if (next === previous) return;
    const current = authRef.current;
    if (!current) return;
    setFloorError(null);
    setSavingFloor(true);
    setFloorByOrg((currentFloors) => ({
      ...currentFloors,
      [orgId]: next,
    }));
    try {
      const fresh = await ensureFreshSession(current);
      if (!fresh) throw new Error(t("cloud.orgPanel.loadError"));
      commitRefreshedAuth(setAuth, current, fresh);
      await setOrgSharingFloor(fresh.accessToken, orgId, next);
      broadcastOrgControlChangedToPeers(orgId, "entitlement");
      await org2CloudSyncEngine.runSyncPassAndWaitForDrain();
    } catch (error) {
      setFloorByOrg((currentFloors) => ({
        ...currentFloors,
        [orgId]: previous,
      }));
      setFloorError(
        isFetchTransportError(error)
          ? t("cloud.orgManagement.errors.network")
          : error instanceof Error
            ? error.message
            : String(error)
      );
    } finally {
      setSavingFloor(false);
    }
  };

  return {
    currentUserId,
    entitlement,
    members: visibleMembers,
    setMembers,
    viewState: signedIn ? fetchState : ("error" as const),
    savedScopes,
    draftScopes,
    setDraftScopes,
    scopesDirty,
    scopeQuota,
    savingScopes,
    scopesSaved,
    scopesError,
    handleSaveScopes,
    orgFloor,
    savingFloor,
    floorError,
    handleFloorChange,
  };
}

export type CloudOrgPanelState = ReturnType<typeof useCloudOrgPanelState>;
