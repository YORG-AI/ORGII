/**
 * Project milestone file reads/writes.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import type { MilestonesFile } from "../types";

export async function readMilestones(slug: string): Promise<MilestonesFile> {
  return cachedRead(`${slug}:milestones`, () =>
    invoke("project_read_milestones", { projectSlug: slug })
  );
}

export async function writeMilestones(
  slug: string,
  milestones: MilestonesFile
): Promise<void> {
  const result = await invoke<void>("project_write_milestones", {
    projectSlug: slug,
    milestones,
  });
  invalidateCache(slug);
  return result;
}
