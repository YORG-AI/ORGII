import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import { type ProjectOrg, projectApi } from "@src/api/http/project";
import type { SelectOption } from "@src/components/Select";
import {
  ALL_CLOUD_SESSIONS_FILTER,
  type CloudSessionFilter,
} from "@src/features/Org2Cloud/cloudSessionFilter";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import {
  buildCloudOrgSelectorValue,
  org2CloudOrgsAtom,
  org2CloudOrgsLoadedAtom,
  parseCloudOrgSelectorValue,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { org2CloudRepoScopesAtom } from "@src/features/Org2Cloud/org2CloudSyncAtoms";
import {
  buildOrgSelectorEntries,
  resolveProjectOrgScopeId,
} from "@src/features/Organizations/orgSelectorEntries";
import { collectScopeMatchedImportedSessionIds } from "@src/features/TeamCollaboration/importedSessionScopeMatch";
import { useShareableScopeKeyVersion } from "@src/features/TeamCollaboration/repoScopeResolver";
import {
  cloudOrgIdsForSession,
  isSessionExcludedFromPersonal,
  sessionOrgTagsAtom,
} from "@src/features/TeamCollaboration/sessionOrgTagsAtom";
import { createLogger } from "@src/hooks/logger";
import { useProjectDataChanged } from "@src/hooks/project";
import { CloudIcon, HugeiconsIcon, LaptopIcon } from "@src/icons";
import { DEFAULT_SESSION_ORG_ID, type Session } from "@src/store/session";

import { sidebarSelectedOrgIdAtom } from "../sidebarOrgScopeAtom";
import { buildSessionOrgFilterIds } from "../useSessionMenuItems/orgFilter";

const logger = createLogger("WorkstationSidebar");

interface UseSidebarOrgScopeParams {
  sortedSessions: Session[];
}

interface ResolveSidebarOrgSelectionInput {
  selectedOrgId: string;
  options: readonly Pick<SelectOption, "value">[];
  cloudAuthed: boolean;
  cloudOrgsLoaded: boolean;
  projectOrgsLoaded: boolean;
}

/** Keep unresolved saved scopes in a loading state, then fall back to local. */
export function resolveSidebarOrgSelection({
  selectedOrgId,
  options,
  cloudAuthed,
  cloudOrgsLoaded,
  projectOrgsLoaded,
}: ResolveSidebarOrgSelectionInput): {
  activeOrgId: string;
  loading: boolean;
} {
  const normalizedOrgId = selectedOrgId || DEFAULT_SESSION_ORG_ID;
  if (options.some((option) => option.value === normalizedOrgId)) {
    return { activeOrgId: normalizedOrgId, loading: false };
  }

  const cloudOrgPending =
    cloudAuthed &&
    !cloudOrgsLoaded &&
    Boolean(parseCloudOrgSelectorValue(normalizedOrgId));
  const localOrgPending =
    normalizedOrgId !== DEFAULT_SESSION_ORG_ID &&
    !parseCloudOrgSelectorValue(normalizedOrgId) &&
    !projectOrgsLoaded;

  if (cloudOrgPending || localOrgPending) {
    return { activeOrgId: normalizedOrgId, loading: true };
  }

  return { activeOrgId: DEFAULT_SESSION_ORG_ID, loading: false };
}

export function useSidebarOrgScope({
  sortedSessions,
}: UseSidebarOrgScopeParams) {
  const { t: tProjects } = useTranslation("projects");
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const cloudOrgsLoaded = useAtomValue(org2CloudOrgsLoadedAtom);
  const cloudAuthed = useAtomValue(org2CloudAuthAtom) !== null;
  const [selectedOrgId, setSelectedOrgId] = useAtom(sidebarSelectedOrgIdAtom);
  const [projectOrgs, setProjectOrgs] = useState<ProjectOrg[]>([]);
  const [projectOrgsLoaded, setProjectOrgsLoaded] = useState(false);

  const fetchProjectOrgs = useCallback(async (): Promise<ProjectOrg[]> => {
    try {
      return await projectApi.readOrgs();
    } catch (error) {
      logger.error("Failed to load sidebar org selector options:", error);
      return [];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetchProjectOrgs().then((orgs) => {
      if (!cancelled) {
        setProjectOrgs(orgs);
        setProjectOrgsLoaded(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fetchProjectOrgs]);

  useProjectDataChanged(
    useCallback(() => {
      void fetchProjectOrgs().then(setProjectOrgs);
    }, [fetchProjectOrgs])
  );

  const orgSelectorOptions = useMemo(
    () =>
      buildOrgSelectorEntries({
        personalOrgId: DEFAULT_SESSION_ORG_ID,
        personalLabel: tProjects("orgs.personalOrg"),
        localOrgs: projectOrgs,
        cloudOrgs,
        localSuffix: "local",
      }).map(
        (entry): SelectOption => ({
          value: entry.value,
          label: entry.label,
          icon:
            entry.kind === "cloud" ? (
              <HugeiconsIcon
                icon={CloudIcon}
                data-icon="cloud"
                size={13}
                strokeWidth={2}
              />
            ) : (
              <HugeiconsIcon
                icon={LaptopIcon}
                data-icon="laptop"
                size={13}
                strokeWidth={2}
              />
            ),
          ...(entry.kind === "personal"
            ? { dataTestId: "sidebar-personal-org-option" }
            : entry.cloudOrgId
              ? { dataTestId: `sidebar-cloud-org-option-${entry.cloudOrgId}` }
              : {}),
        })
      ),
    [cloudOrgs, projectOrgs, tProjects]
  );

  const { activeOrgId, loading: orgSelectorLoading } = useMemo(
    () =>
      resolveSidebarOrgSelection({
        selectedOrgId,
        options: orgSelectorOptions,
        cloudAuthed,
        cloudOrgsLoaded,
        projectOrgsLoaded,
      }),
    [
      cloudAuthed,
      cloudOrgsLoaded,
      orgSelectorOptions,
      projectOrgsLoaded,
      selectedOrgId,
    ]
  );
  const activeProjectOrgId = useMemo(
    () => resolveProjectOrgScopeId(activeOrgId, projectOrgs),
    [activeOrgId, projectOrgs]
  );
  const activeLocalOrg = useMemo(() => {
    if (
      activeOrgId === DEFAULT_SESSION_ORG_ID ||
      parseCloudOrgSelectorValue(activeOrgId)
    ) {
      return null;
    }
    return (
      projectOrgs.find(
        (org) => org.id === activeProjectOrgId && !org.external_org_id
      ) ?? null
    );
  }, [activeOrgId, activeProjectOrgId, projectOrgs]);

  useEffect(() => {
    if (
      selectedOrgId === DEFAULT_SESSION_ORG_ID ||
      selectedOrgId === activeOrgId
    ) {
      return;
    }
    logger.warn(
      `Sidebar scope "${selectedOrgId}" no longer exists; falling back to personal scope`
    );
  }, [activeOrgId, selectedOrgId]);

  const sessionFilterOrgIds = useMemo(
    () => buildSessionOrgFilterIds(activeOrgId),
    [activeOrgId]
  );
  const activeCloudOrg = useMemo(() => {
    const cloudOrgId = parseCloudOrgSelectorValue(activeOrgId);
    if (!cloudOrgId) return null;
    return cloudOrgs.find((org) => org.orgId === cloudOrgId) ?? null;
  }, [activeOrgId, cloudOrgs]);
  const manageableCloudOrg = activeCloudOrg ?? cloudOrgs[0] ?? null;
  const manageableLocalOrg = useMemo(() => {
    if (activeLocalOrg) return activeLocalOrg;
    const cloudOrgIds = new Set(cloudOrgs.map((org) => org.orgId));
    return (
      projectOrgs.find(
        (org) =>
          org.id !== DEFAULT_SESSION_ORG_ID &&
          !org.external_org_id &&
          !cloudOrgIds.has(org.id)
      ) ?? null
    );
  }, [activeLocalOrg, cloudOrgs, projectOrgs]);
  const activeCloudOrgId = activeCloudOrg?.orgId ?? null;

  const setSidebarActiveCloudOrgId = useSetAtom(sidebarActiveCloudOrgIdAtom);
  useLayoutEffect(() => {
    setSidebarActiveCloudOrgId(activeCloudOrgId);
    return () => setSidebarActiveCloudOrgId(null);
  }, [activeCloudOrgId, setSidebarActiveCloudOrgId]);

  const sessionOrgTags = useAtomValue(sessionOrgTagsAtom);
  const repoScopesByOrg = useAtomValue(org2CloudRepoScopesAtom);
  const scopeKeyVersion = useShareableScopeKeyVersion();
  const cloudTaggedSessionIds = useMemo(() => {
    if (!activeCloudOrgId) return undefined;
    const ids = collectScopeMatchedImportedSessionIds(
      sortedSessions,
      repoScopesByOrg[activeCloudOrgId]
    );
    void scopeKeyVersion;
    for (const sessionId of Object.keys(sessionOrgTags)) {
      if (
        cloudOrgIdsForSession(sessionOrgTags, sessionId).includes(
          activeCloudOrgId
        )
      ) {
        ids.add(sessionId);
      }
    }
    return ids;
  }, [
    activeCloudOrgId,
    sessionOrgTags,
    sortedSessions,
    repoScopesByOrg,
    scopeKeyVersion,
  ]);

  const personalHiddenCloudTaggedIds = useMemo(() => {
    if (activeOrgId !== DEFAULT_SESSION_ORG_ID) return undefined;
    const ids = new Set<string>();
    for (const sessionId of Object.keys(sessionOrgTags)) {
      if (isSessionExcludedFromPersonal(sessionOrgTags, sessionId)) {
        ids.add(sessionId);
      }
    }
    return ids.size > 0 ? ids : undefined;
  }, [activeOrgId, sessionOrgTags]);

  const [cloudSessionFilters, setCloudSessionFilters] = useState<
    Map<string, CloudSessionFilter>
  >(new Map());
  const cloudSessionFilter = activeCloudOrgId
    ? (cloudSessionFilters.get(activeCloudOrgId) ?? ALL_CLOUD_SESSIONS_FILTER)
    : ALL_CLOUD_SESSIONS_FILTER;
  const handleCloudSessionFilterChange = useCallback(
    (filter: CloudSessionFilter) => {
      if (!activeCloudOrgId) return;
      setCloudSessionFilters((previous) =>
        new Map(previous).set(activeCloudOrgId, filter)
      );
    },
    [activeCloudOrgId]
  );

  return {
    activeCloudOrgId,
    activeOrgId,
    activeProjectOrgId,
    cloudSessionFilter,
    cloudTaggedSessionIds,
    handleCloudSessionFilterChange,
    manageableCloudOrg,
    manageableLocalOrg,
    orgSelectorLoading,
    orgSelectorOptions,
    personalHiddenCloudTaggedIds,
    sessionFilterOrgIds,
    setSelectedOrgId,
  };
}

export { buildCloudOrgSelectorValue };
