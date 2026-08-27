/**
 * Project CRUD (`project_*_project`) commands.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import type { ProjectData, ProjectMeta } from "../types";
import {
  type ProjectScopeOptions,
  scopeCacheSegment,
  scopeInvokePayload,
} from "./scope";

/** List every project in the global store. */
export async function readProjects(
  options?: ProjectScopeOptions
): Promise<ProjectData[]> {
  const scopeSegment = scopeCacheSegment(options);
  return cachedRead(`__projects__:${scopeSegment}`, () =>
    invoke("project_read_projects", scopeInvokePayload(options))
  );
}

export async function readProject(slug: string): Promise<ProjectData> {
  return cachedRead(`${slug}:project`, () =>
    invoke("project_read_project", { slug })
  );
}

export async function writeProject(
  slug: string,
  meta: ProjectMeta,
  description: string,
  expectNew?: boolean
): Promise<void> {
  const result = await invoke<void>("project_write_project", {
    slug,
    meta,
    description,
    expectNew: expectNew ?? false,
  });
  invalidateCache(slug);
  // Project lists across all repo filters need to refresh.
  invalidateCache("__projects__");
  return result;
}

export async function moveProject(
  slug: string,
  destinationOrgId: string
): Promise<ProjectData> {
  const result = await invoke<ProjectData>("project_move_project", {
    slug,
    destinationOrgId,
  });
  invalidateCache(slug);
  invalidateCache("__projects__");
  return result;
}

export async function deleteProject(slug: string): Promise<void> {
  const result = await invoke<void>("project_delete_project", { slug });
  invalidateCache(slug);
  invalidateCache("__projects__");
  return result;
}
