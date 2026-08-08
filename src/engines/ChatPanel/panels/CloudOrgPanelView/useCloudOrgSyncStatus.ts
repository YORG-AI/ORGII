/**
 * Read-only connection/sync state behind the org panel's Sync tab.
 *
 * Everything here is either already-resolved local state (auth atom, endpoint
 * router, sync journal) or a ONE-SHOT probe on mount (schema version,
 * capabilities). There is deliberately no polling: the tab is a diagnostic
 * surface, and the only way to make it re-read the backend is the explicit
 * manual-sync button, which reuses the engine's existing serialized pass.
 *
 * The hook returns a plain state object so `CloudOrgSyncSection` stays a
 * presentational component (the `useOrgRuntimeTelemetry` /
 * `OrgRuntimeTelemetryState` idiom already used by this panel).
 *
 * SECRETS: only `endpoint.supabaseUrl` is exposed, and only so the section can
 * render its ORIGIN. The anon key, access token, and refresh token never leave
 * this module.
 */
import { useAtomValue, useStore } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  type SessionFilter,
  sessionAggregateList,
  toFrontendSessions,
} from "@src/api/tauri/session";
import { ORG2_CLOUD_EXPECTED_SCHEMA_VERSION } from "@src/features/Org2Cloud/config";
import {
  org2CloudAccessSettingsAtom,
  org2CloudSharingFloorAtom,
} from "@src/features/Org2Cloud/org2CloudAccessSettings";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import type { CloudCapabilities } from "@src/features/Org2Cloud/org2CloudCapabilities";
import { getCloudCapabilities } from "@src/features/Org2Cloud/org2CloudCapabilities";
import { schemaVersion } from "@src/features/Org2Cloud/org2CloudClient";
import { endpointForOrg } from "@src/features/Org2Cloud/org2CloudOrgEndpointRouter";
import {
  org2CloudPushCursorsAtom,
  org2CloudPushedMetadataAtom,
  org2CloudRepoScopesAtom,
} from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import {
  type SessionSyncCoverage,
  computeSessionSyncCoverage,
  createOrgRepoScopeResolver,
  createOrgSyncCoverageEligibilityResolver,
  pushedSessionIdsForOrg,
} from "@src/features/Org2Cloud/org2CloudSyncCoverage";
import { org2CloudSyncEngine } from "@src/features/Org2Cloud/org2CloudSyncEngine";
import {
  type SyncJournalEntry,
  type SyncJournalLastSyncState,
  clearSyncJournal,
  describeSyncError,
  useLastSyncState,
  useSyncJournal,
} from "@src/features/Org2Cloud/org2CloudSyncJournal";
import { useShareableScopeKeyVersion } from "@src/features/TeamCollaboration/repoScopeResolver";
import { sessionOrgTagsAtom } from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import {
  dataSourceConfigAtom,
  externalSessionsEnabledAtom,
} from "@src/store/session/dataSourceConfigAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom/atoms";
import type { Session } from "@src/store/session/sessionAtom/types";

const COVERAGE_ROSTER_PAGE_SIZE = 200;

export interface CompleteCoverageRosterOptions {
  includeExternalHistory: boolean;
  disabledExternalHistorySources: string[];
}

type CoverageRosterPageLoader = (
  filter: SessionFilter
) => ReturnType<typeof sessionAggregateList>;

/** Bounded-page scan of the authoritative session aggregate. */
export async function loadCompleteCoverageRoster(
  options: CompleteCoverageRosterOptions,
  loadPage: CoverageRosterPageLoader = sessionAggregateList
): Promise<Session[]> {
  const byId = new Map<string, Session>();
  let offset = 0;
  for (;;) {
    const response = await loadPage({
      limit: COVERAGE_ROSTER_PAGE_SIZE,
      offset,
      includeExternalHistory: options.includeExternalHistory,
      disabledExternalHistorySources:
        options.includeExternalHistory &&
        options.disabledExternalHistorySources.length > 0
          ? options.disabledExternalHistorySources
          : undefined,
      sortBy: "updated_at",
      sortOrder: "desc",
    });
    const page = toFrontendSessions(response.sessions);
    for (const session of page) byId.set(session.session_id, session);
    if (response.sessions.length < COVERAGE_ROSTER_PAGE_SIZE) break;
    offset += response.sessions.length;
  }
  return [...byId.values()];
}

function mergeCoverageRoster(
  authoritative: readonly Session[],
  live: readonly Session[]
): Session[] {
  const byId = new Map(
    authoritative.map((session) => [session.session_id, session])
  );
  // Live rows preserve frontend-only provenance fields for sessions present in
  // the active store, while the aggregate supplies every older/paged-out row.
  for (const session of live) byId.set(session.session_id, session);
  return [...byId.values()];
}

export type SchemaProbeStatus =
  | "checking"
  | "matched"
  | "mismatched"
  | "unknown";

export interface CloudOrgSyncStatus {
  /** Origin of this org's data-plane endpoint (never the anon key). */
  isOfficialEndpoint: boolean;
  signedIn: boolean;
  userId: string | null;
  /** Access-token expiry in unix MILLIseconds (atom stores seconds). */
  tokenExpiresAtMs: number | null;
  expectedSchemaVersion: number;
  backendSchemaVersion: number | null;
  schemaStatus: SchemaProbeStatus;
  capabilities: CloudCapabilities | null;
  capabilitiesLoading: boolean;
  lastSync: SyncJournalLastSyncState;
  /** Per-repo publish coverage across THIS org's repo scopes. */
  coverage: SessionSyncCoverage;
  /** The complete aggregate is still being read; don't render a false 0%. */
  coverageLoading?: boolean;
  /** The authoritative roster read failed; a visibility/manual-sync retries. */
  coverageUnavailable?: boolean;
  entries: readonly SyncJournalEntry[];
  running: boolean;
  runSucceeded: boolean;
  runError: string | null;
  /** Never throws and never rejects — failures land in `runError`. */
  runSync: () => void;
  clearLog: () => void;
}

export function useCloudOrgSyncStatus(orgId: string): CloudOrgSyncStatus {
  const store = useStore();
  const auth = useAtomValue(org2CloudAuthAtom);
  const entries = useSyncJournal();
  const lastSync = useLastSyncState();

  const accessToken = auth?.accessToken ?? null;
  const endpoint = useMemo(() => endpointForOrg(orgId), [orgId]);

  const dataSourceConfig = useAtomValue(dataSourceConfigAtom);
  const externalSessionsEnabled = useAtomValue(externalSessionsEnabledAtom);
  const [coverageSessions, setCoverageSessions] = useState<Session[]>([]);
  const [coverageLoading, setCoverageLoading] = useState(true);
  const [coverageUnavailable, setCoverageUnavailable] = useState(false);
  const coverageRosterGenerationRef = useRef(0);
  const coverageRosterInFlightRef = useRef<{
    key: string;
    request: Promise<Session[]>;
  } | null>(null);
  const refreshCoverageRoster = useCallback(async () => {
    if (
      typeof document !== "undefined" &&
      document.visibilityState === "hidden"
    ) {
      return;
    }
    const generation = ++coverageRosterGenerationRef.current;
    setCoverageLoading(true);
    setCoverageUnavailable(false);
    const disabledExternalHistorySources = Object.entries(dataSourceConfig)
      .filter(([, config]) => config.enabled === false)
      .map(([sourceId]) => sourceId)
      .sort();
    const requestKey = JSON.stringify([
      externalSessionsEnabled,
      disabledExternalHistorySources,
    ]);
    let load = coverageRosterInFlightRef.current;
    if (!load || load.key !== requestKey) {
      load = {
        key: requestKey,
        request: loadCompleteCoverageRoster({
          includeExternalHistory: externalSessionsEnabled,
          disabledExternalHistorySources,
        }),
      };
      coverageRosterInFlightRef.current = load;
    }
    try {
      const authoritative = await load.request;
      if (generation !== coverageRosterGenerationRef.current) return;
      setCoverageSessions(
        mergeCoverageRoster(authoritative, store.get(sessionsAtom))
      );
      setCoverageLoading(false);
    } catch {
      if (generation !== coverageRosterGenerationRef.current) return;
      // Never present a paginated subset as device-wide coverage. Visibility
      // changes and manual sync both retry the authoritative read.
      setCoverageLoading(false);
      setCoverageUnavailable(true);
    } finally {
      if (coverageRosterInFlightRef.current?.request === load.request) {
        coverageRosterInFlightRef.current = null;
      }
    }
  }, [dataSourceConfig, externalSessionsEnabled, store]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshCoverageRoster();
      }
    };
    void refreshCoverageRoster();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      coverageRosterGenerationRef.current += 1;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [refreshCoverageRoster]);

  const pushedMetadata = useAtomValue(org2CloudPushedMetadataAtom);
  const pushCursors = useAtomValue(org2CloudPushCursorsAtom);
  const tags = useAtomValue(sessionOrgTagsAtom);
  const accessByOrg = useAtomValue(org2CloudAccessSettingsAtom);
  const floorByOrg = useAtomValue(org2CloudSharingFloorAtom);
  // The org's OWN repo scopes are the row set: the panel reports on the repos
  // this org can receive, not every repo on the device. The mirror is the same
  // one the push pass matches against, so the rows and the engine agree.
  const orgScopes = useAtomValue(org2CloudRepoScopesAtom)[orgId];
  // Scope matching reads the shareable-scope-key and repo-identity caches,
  // which fill in asynchronously (both bump this one version). The
  // subscription is what turns a cold cache into rows.
  const scopeKeyVersion = useShareableScopeKeyVersion();
  const coverage = useMemo(() => {
    // The version is an invalidation signal, not an input: reading it here is
    // what makes it an honest dependency rather than a suppressed lint rule.
    void scopeKeyVersion;
    return computeSessionSyncCoverage(
      coverageSessions,
      pushedSessionIdsForOrg(orgId, pushedMetadata, pushCursors),
      createOrgRepoScopeResolver(orgScopes),
      createOrgSyncCoverageEligibilityResolver({
        orgId,
        tags,
        accessByOrg,
        floorByOrg,
      })
    );
  }, [
    orgId,
    orgScopes,
    pushCursors,
    pushedMetadata,
    scopeKeyVersion,
    accessByOrg,
    coverageSessions,
    floorByOrg,
    tags,
  ]);

  const [schemaStatus, setSchemaStatus] =
    useState<SchemaProbeStatus>("checking");
  const [backendSchemaVersion, setBackendSchemaVersion] = useState<
    number | null
  >(null);
  const [capabilities, setCapabilities] = useState<CloudCapabilities | null>(
    null
  );
  const [capabilitiesLoading, setCapabilitiesLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [runSucceeded, setRunSucceeded] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  // One-shot schema probe. Re-runs only when the org's endpoint changes.
  useEffect(() => {
    let cancelled = false;
    setSchemaStatus("checking");
    setBackendSchemaVersion(null);
    void schemaVersion()
      .then((version) => {
        if (cancelled) return;
        setBackendSchemaVersion(version);
        if (version === null) {
          setSchemaStatus("unknown");
          return;
        }
        setSchemaStatus(
          version === ORG2_CLOUD_EXPECTED_SCHEMA_VERSION
            ? "matched"
            : "mismatched"
        );
      })
      .catch(() => {
        if (cancelled) return;
        setSchemaStatus("unknown");
      });
    return () => {
      cancelled = true;
    };
  }, [endpoint.supabaseUrl]);

  // Capabilities need a token; the probe itself is cached per endpoint.
  useEffect(() => {
    if (!accessToken) {
      setCapabilities(null);
      setCapabilitiesLoading(false);
      return;
    }
    let cancelled = false;
    setCapabilitiesLoading(true);
    void getCloudCapabilities(accessToken)
      .then((probed) => {
        if (cancelled) return;
        setCapabilities(probed);
      })
      .catch(() => {
        if (cancelled) return;
        setCapabilities(null);
      })
      .finally(() => {
        if (cancelled) return;
        setCapabilitiesLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [accessToken]);

  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const runSync = useCallback(() => {
    if (running) return;
    setRunning(true);
    setRunError(null);
    setRunSucceeded(false);
    void (async () => {
      try {
        await org2CloudSyncEngine.runSyncPassAndWaitForDrain();
        if (!mountedRef.current) return;
        await refreshCoverageRoster();
        if (!mountedRef.current) return;
        setRunSucceeded(true);
      } catch (error) {
        if (!mountedRef.current) return;
        setRunError(describeSyncError(error).message);
      } finally {
        if (mountedRef.current) setRunning(false);
      }
    })();
  }, [refreshCoverageRoster, running]);

  return {
    // The endpoint URL is deliberately NOT exposed: the panel only reports
    // WHICH KIND of backend this org talks to. Nothing downstream can render
    // the host, so there is no path for it to leak into the UI or the copied
    // journal.
    isOfficialEndpoint: endpoint.isOfficial,
    signedIn: Boolean(auth),
    userId: auth?.userId ?? null,
    tokenExpiresAtMs:
      typeof auth?.expiresAt === "number" ? auth.expiresAt * 1000 : null,
    expectedSchemaVersion: ORG2_CLOUD_EXPECTED_SCHEMA_VERSION,
    backendSchemaVersion,
    schemaStatus,
    capabilities,
    capabilitiesLoading,
    lastSync,
    coverage,
    coverageLoading,
    coverageUnavailable,
    entries,
    running,
    runSucceeded,
    runError,
    runSync,
    clearLog: clearSyncJournal,
  };
}
