/**
 * Project label file reads/writes.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import type { LabelsFile } from "../types";

export async function readLabels(slug: string): Promise<LabelsFile> {
  return cachedRead(`${slug}:labels`, () =>
    invoke("project_read_labels", { projectSlug: slug })
  );
}

export async function writeLabels(
  slug: string,
  labels: LabelsFile
): Promise<void> {
  const result = await invoke<void>("project_write_labels", {
    projectSlug: slug,
    labels,
  });
  invalidateCache(slug);
  return result;
}
