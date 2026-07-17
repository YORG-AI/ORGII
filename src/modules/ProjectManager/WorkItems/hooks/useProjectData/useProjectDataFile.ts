/**
 * useProjectDataFile
 *
 * Slug-keyed fetch/update functions for project data backed by the
 * SQLite project store.
 */
import { useCallback } from "react";

import {
  buildLabelMap,
  buildMemberMap,
  projectApi,
  projectDataToUI,
} from "@src/api/http/project";
import type {
  ProjectData as FileProjectData,
  MemberEntry,
} from "@src/api/http/project";
import type { ProjectData } from "@src/modules/ProjectManager/shared";
import { STORY_PERSONAL_ORG_FILTER_ID } from "@src/store/workstation/tabs";
import type { Label, Person } from "@src/types/core/shared";

import { deriveWorkItemPrefix } from "../../config";

function normalizeWorkItemPrefix(prefix: string): string {
  return prefix.trim().toUpperCase();
}

interface FetchFromFilesResult {
  project: ProjectData | null;
  allProjects: { id: string; name: string; slug: string }[];
  labels: Label[];
  members: Person[];
  rawMembers: MemberEntry[];
  autoSelectedId: string | null;
}

export interface UseProjectDataFileReturn {
  fetchFromFiles: (
    selectedProjectId: string | null
  ) => Promise<FetchFromFilesResult>;
  updateProjectFile: (
    project: ProjectData,
    updates: Partial<ProjectData>
  ) => Promise<boolean>;
}

export function useProjectDataFile(): UseProjectDataFileReturn {
  const fetchFromFiles = useCallback(
    async (selectedProjectId: string | null): Promise<FetchFromFilesResult> => {
      const projectsData = await projectApi.readProjects();

      // Find the project matching the selectedProjectId, falling back to the first.
      const targetProject =
        projectsData.find((proj) => proj.meta.id === selectedProjectId) ??
        projectsData[0] ??
        null;

      if (!targetProject) {
        return {
          project: null,
          allProjects: [],
          labels: [],
          members: [],
          rawMembers: [],
          autoSelectedId: null,
        };
      }

      const slug = targetProject.slug;
      const [labelsFile, membersFile] = await Promise.all([
        projectApi.readLabels(slug),
        projectApi.readMembers(slug),
      ]);

      const labelMap = buildLabelMap(labelsFile.labels);
      const memberMap = buildMemberMap(membersFile.members);

      const labels: Label[] = labelsFile.labels;

      const rawMembers: MemberEntry[] = membersFile.members.map((member) => ({
        ...member,
        active: member.active ?? true,
      }));

      const activeMemberMap = new Map<string, MemberEntry>();
      for (const member of rawMembers) {
        if (!member.active) continue;
        const existing = activeMemberMap.get(member.id);
        if (
          !existing ||
          (member.last_commit_date ?? "") > (existing.last_commit_date ?? "")
        ) {
          activeMemberMap.set(member.id, member);
        }
      }
      const members: Person[] = Array.from(activeMemberMap.values()).map(
        (member) => ({
          id: member.id,
          name: member.name,
          email: member.email,
          avatar: member.avatar,
        })
      );

      const uiProjects = projectsData.map((proj: FileProjectData) =>
        projectDataToUI(proj, { labelMap, memberMap })
      );

      const targetId = targetProject.meta.id;
      const selected = uiProjects.find((proj) => proj.id === targetId);

      const project: ProjectData | null = selected
        ? {
            id: selected.id,
            name: selected.name,
            description: selected.description,
            slug: selected.slug,
            orgId: selected.orgId,
            workItemPrefix: selected.workItemPrefix,
            workItemPrefixCustom: selected.workItemPrefixCustom,
            status: selected.status,
            priority: selected.priority,
            health: selected.health,
            lead: selected.lead,
            members: selected.members,
            teams: selected.teams,
            labels: selected.labels,
            linkedRepos: selected.linkedRepos?.map((repo) => ({
              id: repo.id,
              name: repo.name,
            })),
            startDate: selected.startDate,
            targetDate: selected.targetDate,
            completionPercentage: selected.completionPercentage,
            statusBreakdown: selected.statusBreakdown,
          }
        : null;

      return {
        project,
        allProjects: uiProjects.map((proj) => ({
          id: proj.id,
          name: proj.name,
          slug: proj.slug ?? "",
        })),
        labels,
        members,
        rawMembers,
        autoSelectedId: targetId !== selectedProjectId ? targetId : null,
      };
    },
    []
  );

  const updateProjectFile = useCallback(
    async (
      currentProject: ProjectData,
      updates: Partial<ProjectData>
    ): Promise<boolean> => {
      const merged = { ...currentProject, ...updates };
      const slug =
        currentProject.slug ||
        merged.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
      const now = new Date().toISOString();
      const existingPrefix = normalizeWorkItemPrefix(
        merged.workItemPrefix ?? deriveWorkItemPrefix(merged.name)
      );
      const prefixIsCustom = merged.workItemPrefixCustom ?? false;

      const memberIds =
        merged.members?.map((member: Person) => member.id) ?? [];
      const labelIds = merged.labels?.map((label: Label) => label.id) ?? [];
      const description = merged.description ?? "";

      const existing = await projectApi.readProject(slug).catch(() => null);
      const nextWorkItemId = existing?.meta.next_work_item_id ?? 1;
      // Prefer the merged value (user just edited the linked repos); fall
      // back to the on-disk value so untouched edits don't drop them.
      const linkedRepos = merged.linkedRepos
        ? merged.linkedRepos.map((repo: { id: string }) => repo.id)
        : (existing?.meta.linked_repos ?? []);

      await projectApi.writeProject(
        slug,
        {
          id: merged.id,
          name: merged.name,
          org_id: existing?.meta.org_id ?? STORY_PERSONAL_ORG_FILTER_ID,
          status: merged.status || "backlog",
          priority: merged.priority || "none",
          health: merged.health || "no_updates",
          lead: merged.lead?.id,
          members: memberIds,
          labels: labelIds,
          linked_repos: linkedRepos,
          start_date: merged.startDate,
          target_date: merged.targetDate,
          created_at: now,
          updated_at: now,
          next_work_item_id: nextWorkItemId,
          work_item_prefix: prefixIsCustom
            ? existingPrefix
            : deriveWorkItemPrefix(merged.name),
          work_item_prefix_custom: prefixIsCustom,
        },
        description
      );

      return true;
    },
    []
  );

  return { fetchFromFiles, updateProjectFile };
}
