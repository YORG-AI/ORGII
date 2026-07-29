/**
 * Data hook for the Runtime → Team section.
 *
 * Owns the cloud reads: org selection over `org2CloudOrgsAtom`, fresh-token
 * resolution (the `ensureFreshSession` + `commitRefreshedAuth` panel idiom
 * from `useCloudOrgPanelState`), the `memberRuntime` capability probe, and the
 * roster fetch. Refetches on mount and on the document becoming visible —
 * deliberately no polling loop; the data is hourly-coarse.
 */
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

import { listMemberRuntime } from "@src/features/Org2Cloud/memberRuntime/memberRuntimeClient";
import type {
  MemberRuntimeListEntry,
  OrgRuntimeTelemetry,
} from "@src/features/Org2Cloud/memberRuntime/types";
import {
  commitRefreshedAuth,
  org2CloudAuthAtom,
  org2CloudAuthIdentityKey,
} from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { getCloudCapabilities } from "@src/features/Org2Cloud/org2CloudCapabilities";
import { ensureFreshSession } from "@src/features/Org2Cloud/org2CloudClient";
import {
  type Org2CloudOrg,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { createLogger } from "@src/hooks/logger";

import { readOrgRuntimeTelemetry } from "./teamRuntimeData";

const log = createLogger("TeamRuntimeRoster");

/**
 * `memberRuntime` joins `CloudCapabilities` with the plumbing change; read it
 * structurally so this file compiles (and behaves: absent ⇒ unsupported)
 * against the pre-landing probe shape.
 */
function hasMemberRuntimeCapability(capabilities: object): boolean {
  return (capabilities as Record<string, unknown>)["memberRuntime"] === true;
}

export type TeamRuntimePhase =
  | "signedOut"
  | "noOrgs"
  | "loading"
  | "unsupported"
  | "disabled"
  | "error"
  | "ready";

export interface TeamRuntimeRosterState {
  phase: TeamRuntimePhase;
  orgs: Org2CloudOrg[];
  selectedOrgId: string | null;
  selectOrg: (orgId: string) => void;
  /** Telemetry setting of the selected org (null = unset ⇒ disabled). */
  telemetry: OrgRuntimeTelemetry | null;
  /** Viewer is admin/owner of the selected org (for the enable hint). */
  isSelectedOrgAdmin: boolean;
  members: MemberRuntimeListEntry[];
  error: string | null;
  refreshing: boolean;
  refresh: () => void;
  /** Fresh access token for follow-up RPCs (drilldown, clear). */
  getFreshAccessToken: () => Promise<string>;
  currentUserId: string | null;
}

const NO_MEMBERS: MemberRuntimeListEntry[] = [];

export function useTeamRuntimeRoster(): TeamRuntimeRosterState {
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const orgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);

  const [pickedOrgId, setPickedOrgId] = useState<string | null>(null);
  const selectedOrgId =
    pickedOrgId && orgs.some((org) => org.orgId === pickedOrgId)
      ? pickedOrgId
      : (orgs[0]?.orgId ?? null);
  const selectedOrg = orgs.find((org) => org.orgId === selectedOrgId) ?? null;
  const telemetry = readOrgRuntimeTelemetry(selectedOrg);
  const telemetryEnabled = telemetry?.enabled === true;

  // null = probe not answered yet for this sign-in.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [members, setMembers] = useState<MemberRuntimeListEntry[] | null>(null);
  const [membersKey, setMembersKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const rosterKey = authIdentityKey
    ? `${authIdentityKey}|${selectedOrgId ?? ""}`
    : null;

  // Latest auth via ref (panel idiom): token-refresh writes must not
  // retrigger the fetch effect.
  const authRef = useRef(auth);
  useEffect(() => {
    authRef.current = auth;
  }, [auth]);

  // Tauri-side fetches are not abortable and cloud fetches may settle after
  // an org/account switch; a monotonic counter drops late completions.
  const requestRef = useRef(0);
  useEffect(
    () => () => {
      requestRef.current += 1;
    },
    []
  );

  // Identity switches are a hard visibility boundary (orgs-atom idiom).
  useEffect(() => {
    setSupported(null);
    setMembers(null);
    setMembersKey(null);
    setError(null);
  }, [authIdentityKey]);

  const getFreshAccessToken = useCallback(async (): Promise<string> => {
    const current = authRef.current;
    if (!current) throw new Error("signed out");
    const fresh = await ensureFreshSession(current);
    if (!fresh) throw new Error("cloud session refresh failed");
    commitRefreshedAuth(setAuth, current, fresh);
    return fresh.accessToken;
  }, [setAuth]);

  useEffect(() => {
    if (!authIdentityKey || !selectedOrgId) return;
    let cancelled = false;
    const seq = ++requestRef.current;
    void (async () => {
      setFetching(true);
      setError(null);
      try {
        const accessToken = await getFreshAccessToken();
        const capabilities = await getCloudCapabilities(accessToken);
        const isSupported = hasMemberRuntimeCapability(capabilities);
        if (cancelled || seq !== requestRef.current) return;
        setSupported(isSupported);
        // Roster reads are pointless against an unsupported backend, and the
        // disabled explainer replaces the roster while telemetry is off.
        if (!isSupported || !telemetryEnabled) return;
        const roster = await listMemberRuntime(accessToken, selectedOrgId);
        if (cancelled || seq !== requestRef.current) return;
        setMembers(roster);
        setMembersKey(`${authIdentityKey}|${selectedOrgId}`);
      } catch (err) {
        log.warn("team runtime roster fetch failed:", err);
        if (!cancelled && seq === requestRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!cancelled && seq === requestRef.current) setFetching(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    authIdentityKey,
    selectedOrgId,
    telemetryEnabled,
    refreshNonce,
    getFreshAccessToken,
  ]);

  const refresh = useCallback(() => {
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  // Refetch on the hidden → visible edge; the effect above covers mount.
  useEffect(() => {
    if (!authIdentityKey) return;
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [authIdentityKey, refresh]);

  const visibleMembers =
    membersKey !== null && membersKey === rosterKey ? members : null;

  let phase: TeamRuntimePhase;
  if (!auth) {
    phase = "signedOut";
  } else if (!selectedOrgId) {
    phase = orgsLoaded ? "noOrgs" : "loading";
  } else if (visibleMembers === null && error !== null) {
    phase = "error";
  } else if (supported === false) {
    phase = "unsupported";
  } else if (supported === null) {
    phase = "loading";
  } else if (!telemetryEnabled) {
    phase = "disabled";
  } else if (visibleMembers === null) {
    phase = "loading";
  } else {
    phase = "ready";
  }

  return {
    phase,
    orgs,
    selectedOrgId,
    selectOrg: setPickedOrgId,
    telemetry,
    isSelectedOrgAdmin:
      selectedOrg?.role === "admin" || selectedOrg?.role === "owner",
    members: visibleMembers ?? NO_MEMBERS,
    error,
    refreshing: fetching,
    refresh,
    getFreshAccessToken,
    currentUserId: auth?.userId ?? null,
  };
}
