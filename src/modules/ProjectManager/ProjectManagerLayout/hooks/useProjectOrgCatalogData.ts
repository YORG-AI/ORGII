import { useCallback, useMemo, useState } from "react";

import { PROJECT_ORG_SYNC_PROVIDER, projectApi } from "@src/api/http/project";
import type {
  LabelEntry,
  ProjectData,
  ProjectOrg,
} from "@src/api/http/project";
import { useAsyncResource } from "@src/hooks/async";
import type { Label } from "@src/types/core/shared";

interface LabelsByProject {
  projectSlug: string;
  labels: LabelEntry[];
}

function parseGitFolderPath(org: ProjectOrg | null): string {
  if (!org?.sync_config_json) return "";
  const parsed = JSON.parse(org.sync_config_json) as { folder_path?: unknown };
  return typeof parsed.folder_path === "string" ? parsed.folder_path : "";
}

function mergeLabels(projectLabels: LabelsByProject[]): Label[] {
  const labelMap = new Map<string, Label>();
  for (const entry of projectLabels) {
    for (const label of entry.labels) {
      if (!labelMap.has(label.id)) {
        labelMap.set(label.id, label);
      }
    }
  }
  return Array.from(labelMap.values()).sort((labelA, labelB) =>
    labelA.name.localeCompare(labelB.name)
  );
}

interface ProjectOrgCatalogResource {
  labelsByProject: LabelsByProject[];
  org: ProjectOrg | null;
  projects: ProjectData[];
}

const EMPTY_PROJECT_ORG_CATALOG: ProjectOrgCatalogResource = {
  labelsByProject: [],
  org: null,
  projects: [],
};

export function useProjectOrgCatalogData(orgId: string) {
  const [folderDraft, setFolderDraft] = useState<{
    baseValue: string;
    orgId: string;
    value: string;
  } | null>(null);

  const fetchOrgCatalog = useCallback(async (scopeOrgId: string) => {
    const [allOrgs, projects] = await Promise.all([
      projectApi.readOrgs(),
      projectApi.readProjects({ orgId: scopeOrgId }),
    ]);
    const org = allOrgs.find((entry) => entry.id === scopeOrgId);
    if (!org) {
      throw new Error(`Project org not found: ${scopeOrgId}`);
    }
    const labelsByProject = await Promise.all(
      projects.map(async (project) => ({
        projectSlug: project.slug,
        labels: (await projectApi.readLabels(project.slug)).labels,
      }))
    );
    return { labelsByProject, org, projects };
  }, []);

  const resource = useAsyncResource({
    enabled: Boolean(orgId),
    fetcher: fetchOrgCatalog,
    initialData: EMPTY_PROJECT_ORG_CATALOG,
    scopeKey: orgId || null,
  });
  const {
    data: catalog,
    error: loadError,
    loading,
    refresh: reload,
    setData: setCatalog,
  } = resource;
  const { labelsByProject, org, projects } = catalog;
  const storedFolderPath = parseGitFolderPath(org);
  const folderPath =
    folderDraft?.orgId === orgId && folderDraft.baseValue === storedFolderPath
      ? folderDraft.value
      : storedFolderPath;
  const setFolderPath = useCallback(
    (value: string) => {
      setFolderDraft({
        baseValue: storedFolderPath,
        orgId,
        value,
      });
    },
    [orgId, storedFolderPath]
  );

  const labels = useMemo(() => mergeLabels(labelsByProject), [labelsByProject]);

  const handleUpdateLabels = useCallback(
    async (updatedLabels: Label[]) => {
      if (projects.length === 0) return;
      await Promise.all(
        projects.map((project) =>
          projectApi.writeLabels(project.slug, { labels: updatedLabels })
        )
      );
      setCatalog((current) => ({
        ...current,
        labelsByProject: projects.map((project) => ({
          projectSlug: project.slug,
          labels: updatedLabels,
        })),
      }));
    },
    [projects, setCatalog]
  );

  const handleConfigureGitFolder = useCallback(async () => {
    const configuredOrg = await projectApi.configureOrgGitFolderSync({
      org_id: orgId,
      folder_path: folderPath.trim(),
    });
    setCatalog((current) => ({ ...current, org: configuredOrg }));
    const configuredFolderPath = parseGitFolderPath(configuredOrg);
    setFolderDraft({
      baseValue: configuredFolderPath,
      orgId,
      value: configuredFolderPath,
    });
  }, [folderPath, orgId, setCatalog]);

  const handleSyncGitFolder = useCallback(async () => {
    const result = await projectApi.syncOrgGitFolder({ org_id: orgId });
    await reload();
    return result;
  }, [orgId, reload]);

  const handleDeleteOrg = useCallback(async () => {
    await projectApi.deleteOrg(orgId);
    setCatalog(EMPTY_PROJECT_ORG_CATALOG);
  }, [orgId, setCatalog]);

  const isGitFolderSynced =
    org?.sync_provider === PROJECT_ORG_SYNC_PROVIDER.GIT_FOLDER;

  return {
    org,
    projects,
    labels,
    folderPath,
    setFolderPath,
    loading,
    loadError,
    isGitFolderSynced,
    handleUpdateLabels,
    handleConfigureGitFolder,
    handleSyncGitFolder,
    handleDeleteOrg,
    reload,
  };
}
