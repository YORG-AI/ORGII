/**
 * Project member file reads/writes.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import { notifyProjectRosterChanged } from "../events";
import type { MembersFile } from "../types";

export async function readMembers(slug: string): Promise<MembersFile> {
  return cachedRead(`${slug}:members`, () =>
    invoke("project_read_members", { projectSlug: slug })
  );
}

export async function writeMembers(
  slug: string,
  members: MembersFile
): Promise<void> {
  const result = await invoke<void>("project_write_members", {
    projectSlug: slug,
    members,
  });
  invalidateCache(slug);
  notifyProjectRosterChanged({ project_slug: slug, source: "members" });
  return result;
}
