/**
 * Data hook for Runtime's organization-scoped sections.
 *
 * Owns the cloud reads for the org id controlled by the Runtime header:
 * fresh-token resolution (the `ensureFreshSession` + `commitRefreshedAuth`
 * panel idiom from `useCloudOrgPanelState`), the `memberRuntime` capability
 * probe, and the roster fetch. Refetches on mount and on the document becoming
 * visible — deliberately no polling loop; the data is hourly-coarse.
 */
import { useAtom, useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  org2CloudMemberRuntimeVersionAtom,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { createLogger } from "@src/hooks/logger";

import { readOrgRuntimeTelemetry } from "./teamRuntimeData";

const log = createLogger("TeamRuntimeRoster");

const VISIBLE_EDGE_REFRESH_COOLDOWN_MS = 30_000;

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
  selectedOrgId: string | null;
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
  /** Same `${supabaseUrl}|${userId}` key the push scheduler namespaces its
   * localStorage state under; null when signed out. Lets self-service flows
   * (stop-sharing) reset the scheduler's per-(identity, org) push state
   * without duplicating its derivation. */
  identityKey: string | null;
}

const NO_MEMBERS: MemberRuntimeListEntry[] = [];

/**
 * If cloud auth exists but `org2CloudOrgsAtom` never resolves (its token
 * refresh silently failed and auth was NOT cleared — see the "cloud org
 * fetch skipped: token refresh failed" log path there), `org2CloudOrgsLoadedAtom`
 * can stay false forever. Left unchecked, the phase derivation below pins at
 * "loading" indefinitely — an infinite spinner with no recovery affordance.
 * Bound the wait: if we're still stuck after this long, surface the existing
 * error phase (with its retry button) instead of spinning forever.
 */
const ORG_LOAD_STALL_MS = 20_000;

/**
 * This hook has no handle on the orgs fetch itself (that lives in
 * `org2CloudOrgsAtom`), so there's nothing to re-kick on retry beyond
 * re-arming this window and letting the atom get another chance to resolve
 * before we flag it stuck again.
 */
const ORG_LOAD_STALL_ERROR =
  "Couldn't load your cloud organizations. Try refreshing, or sign out and back in if this keeps happening.";

export function useTeamRuntimeRoster(
  requestedOrgId?: string
): TeamRuntimeRosterState {
  const [auth, setAuth] = useAtom(org2CloudAuthAtom);
  const orgs = useAtomValue(org2CloudOrgsAtom);
  const orgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);

  const selectedOrgId =
    requestedOrgId === undefined
      ? (orgs[0]?.orgId ?? null)
      : orgs.some((org) => org.orgId === requestedOrgId)
        ? requestedOrgId
        : null;
  const selectedOrg = orgs.find((org) => org.orgId === selectedOrgId) ?? null;
  const rawTelemetry = readOrgRuntimeTelemetry(selectedOrg);
  // `readOrgRuntimeTelemetry` builds a fresh object every call, which would
  // otherwise bust the `TeamMemberCard` React.memo comparison on every
  // roster-panel render. Reuse the previous reference while the two fields
  // that actually matter are unchanged — deliberately keyed on those
  // primitives instead of `rawTelemetry` itself, which would defeat the
  // memoization (it's a new object every render by construction).
  const telemetry = useMemo(
    () => rawTelemetry,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rawTelemetry?.enabled, rawTelemetry?.intervalMinutes]
  );
  const telemetryEnabled = telemetry?.enabled === true;

  // null = probe not answered yet for this sign-in.
  const [supported, setSupported] = useState<boolean | null>(null);
  const [members, setMembers] = useState<MemberRuntimeListEntry[] | null>(null);
  const [membersKey, setMembersKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [fetching, setFetching] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  // Set once the "waiting on cloud orgs" condition below has held for
  // ORG_LOAD_STALL_MS; cleared as soon as it lifts (orgs load, or auth goes
  // away). See the effect below and the ORG_LOAD_STALL_MS comment.
  const [stalledAtMs, setStalledAtMs] = useState<number | null>(null);

  const authIdentityKey = auth ? org2CloudAuthIdentityKey(auth) : null;
  const rosterKey = authIdentityKey
    ? `${authIdentityKey}|${selectedOrgId ?? ""}`
    : null;
  const memberRuntimeVersion =
    useAtomValue(org2CloudMemberRuntimeVersionAtom)[selectedOrgId ?? ""] ?? 0;
  const lastFetchStartedAtRef = useRef(0);

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
    lastFetchStartedAtRef.current = Date.now();
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
    memberRuntimeVersion,
    getFreshAccessToken,
  ]);

  const refresh = useCallback(() => {
    lastFetchStartedAtRef.current = Date.now();
    setRefreshNonce((nonce) => nonce + 1);
  }, []);

  // Refetch on the hidden → visible edge; the effect above covers mount.
  // Cooled down so cmd-tab flapping cannot multiply roster reads — the
  // realtime member_runtime signal covers freshness in between.
  useEffect(() => {
    if (!authIdentityKey) return;
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") return;
      if (
        Date.now() - lastFetchStartedAtRef.current <
        VISIBLE_EDGE_REFRESH_COOLDOWN_MS
      ) {
        return;
      }
      refresh();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () =>
      document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [authIdentityKey, refresh]);

  // Bounded stall detector for the "auth present, no org picked yet, orgs
  // atom hasn't loaded" window (see ORG_LOAD_STALL_MS above).
  const awaitingOrgs = Boolean(auth) && !selectedOrgId && !orgsLoaded;
  useEffect(() => {
    if (!awaitingOrgs) {
      setStalledAtMs(null);
      return;
    }
    // Re-arm on every refresh (including a stall-error retry): clear any
    // prior stall immediately so the phase re-evaluates as "loading" while
    // this fresh window runs.
    setStalledAtMs(null);
    const timer = setTimeout(
      () => setStalledAtMs(Date.now()),
      ORG_LOAD_STALL_MS
    );
    return () => clearTimeout(timer);
  }, [awaitingOrgs, refreshNonce]);

  const visibleMembers =
    membersKey !== null && membersKey === rosterKey ? members : null;

  let phase: TeamRuntimePhase;
  if (!auth) {
    phase = "signedOut";
  } else if (!selectedOrgId) {
    phase = orgsLoaded ? "noOrgs" : stalledAtMs !== null ? "error" : "loading";
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
    selectedOrgId,
    telemetry,
    isSelectedOrgAdmin:
      selectedOrg?.role === "admin" || selectedOrg?.role === "owner",
    members: visibleMembers ?? NO_MEMBERS,
    error: stalledAtMs !== null ? ORG_LOAD_STALL_ERROR : error,
    refreshing: fetching,
    refresh,
    getFreshAccessToken,
    currentUserId: auth?.userId ?? null,
    identityKey: authIdentityKey,
  };
}
