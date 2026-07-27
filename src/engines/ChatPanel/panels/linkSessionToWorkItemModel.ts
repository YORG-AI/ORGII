import type { EnrichedWorkItem, ProjectData } from "@src/api/http/project";

export interface WorkItemLinkOption {
  project: ProjectData;
  item: EnrichedWorkItem;
}

export interface AsyncGenerationGuard {
  begin: () => number;
  invalidate: () => void;
  isCurrent: (generation: number) => boolean;
}

/** Rejects late async completions after close, unmount, or a newer operation. */
export function createAsyncGenerationGuard(): AsyncGenerationGuard {
  let currentGeneration = 0;
  return {
    begin: () => {
      currentGeneration += 1;
      return currentGeneration;
    },
    invalidate: () => {
      currentGeneration += 1;
    },
    isCurrent: (generation) => currentGeneration === generation,
  };
}

/**
 * Loads work items with bounded fan-out. Closing the modal stops workers from
 * starting more reads; already-running Tauri commands cannot be aborted, so
 * their completions are ignored by the generation guard.
 */
export async function loadWorkItemLinkOptions(
  projects: readonly ProjectData[],
  readWorkItems: (projectSlug: string) => Promise<EnrichedWorkItem[]>,
  isCurrent: () => boolean,
  concurrency = 4
): Promise<WorkItemLinkOption[] | null> {
  if (!isCurrent()) return null;
  const groups: WorkItemLinkOption[][] = new Array(projects.length);
  let nextProjectIndex = 0;

  const worker = async () => {
    while (isCurrent()) {
      const projectIndex = nextProjectIndex;
      nextProjectIndex += 1;
      if (projectIndex >= projects.length) return;

      const project = projects[projectIndex];
      const workItems = await readWorkItems(project.slug);
      if (!isCurrent()) return;
      groups[projectIndex] = workItems.map((item) => ({ project, item }));
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), projects.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return isCurrent() ? groups.flat() : null;
}
