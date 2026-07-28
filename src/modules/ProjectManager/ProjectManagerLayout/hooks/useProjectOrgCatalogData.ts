import { useCallback, useEffect, useMemo, useState } from "react";

import { PROJECT_ORG_SYNC_PROVIDER, projectApi } from "@src/api/http/project";
import type {
  LabelEntry,
  ProjectData,
  ProjectOrg,
} from "@src/api/http/project";
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

export function useProjectOrgCatalogData(orgId: string) {
  const [org, setOrg] = useState<ProjectOrg | null>(null);
  const [projects, setProjects] = useState<ProjectData[]>([]);
  const [labelsByProject, setLabelsByProject] = useState<LabelsByProject[]>([]);
  const [folderPath, setFolderPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const loadOrgCatalog = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [allOrgs, orgProjects] = await Promise.all([
        projectApi.readOrgs(),
        projectApi.readProjects({ orgId }),
      ]);
      const currentOrg = allOrgs.find((entry) => entry.id === orgId);
      if (!currentOrg) {
        throw new Error(`Project org not found: ${orgId}`);
      }
      const nextLabelsByProject = await Promise.all(
        orgProjects.map(async (project) => ({
          projectSlug: project.slug,
          labels: (await projectApi.readLabels(project.slug)).labels,
        }))
      );
      setOrg(currentOrg);
      setProjects(orgProjects);
      setLabelsByProject(nextLabelsByProject);
      setFolderPath(parseGitFolderPath(currentOrg));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => {
    void loadOrgCatalog();
  }, [loadOrgCatalog]);

  const labels = useMemo(() => mergeLabels(labelsByProject), [labelsByProject]);

  const handleUpdateLabels = useCallback(
    async (updatedLabels: Label[]) => {
      if (projects.length === 0) return;
      await Promise.all(
        projects.map((project) =>
          projectApi.writeLabels(project.slug, { labels: updatedLabels })
        )
      );
      setLabelsByProject(
        projects.map((project) => ({
          projectSlug: project.slug,
          labels: updatedLabels,
        }))
      );
    },
    [projects]
  );

  const handleConfigureGitFolder = useCallback(async () => {
    const configuredOrg = await projectApi.configureOrgGitFolderSync({
      org_id: orgId,
      folder_path: folderPath.trim(),
    });
    setOrg(configuredOrg);
    setFolderPath(parseGitFolderPath(configuredOrg));
  }, [folderPath, orgId]);

  const handleSyncGitFolder = useCallback(async () => {
    const result = await projectApi.syncOrgGitFolder({ org_id: orgId });
    await loadOrgCatalog();
    return result;
  }, [loadOrgCatalog, orgId]);

  const handleDeleteOrg = useCallback(async () => {
    await projectApi.deleteOrg(orgId);
    setOrg(null);
    setProjects([]);
    setLabelsByProject([]);
  }, [orgId]);

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
    reload: loadOrgCatalog,
  };
}
