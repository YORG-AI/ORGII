/**
 * Draft Atoms for Project Manager Create Forms
 *
 * Caches in-progress "New Project" and "New Work Item" form data.
 * Keyed by the create surface ID supplied by the caller.
 *
 * Memory: Capped at MAX_DRAFTS entries (FIFO eviction).
 */
import { atom } from "jotai";

import { WORK_ITEM_STATUS } from "@src/types/core/workItem";

// ============================================
// Constants
// ============================================

const MAX_DRAFTS = 20;

/** Shared draft key for chat-panel project creator. */
export const PROJECT_CREATOR_DRAFT_ID = "project-creator";

/** Shared draft key for chat-panel and modal work item creators. */
export const WORK_ITEM_CREATOR_DRAFT_ID = "work-item-creator";

const PINNED_PROJECT_DRAFT_IDS = new Set<string>([PROJECT_CREATOR_DRAFT_ID]);

const PINNED_WORK_ITEM_DRAFT_IDS = new Set<string>([
  WORK_ITEM_CREATOR_DRAFT_ID,
]);

function writeDraftMapEntry<K, V>(
  previous: Map<K, V>,
  key: K,
  value: V
): Map<K, V> {
  const next = new Map(previous);
  // Touch the key so recently edited drafts are not FIFO-evicted first.
  next.delete(key);
  next.set(key, value);

  while (next.size > MAX_DRAFTS) {
    let evicted = false;
    for (const candidateKey of next.keys()) {
      const draftKey = String(candidateKey);
      if (
        PINNED_PROJECT_DRAFT_IDS.has(draftKey) ||
        PINNED_WORK_ITEM_DRAFT_IDS.has(draftKey)
      ) {
        continue;
      }
      next.delete(candidateKey);
      evicted = true;
      break;
    }
    if (!evicted) break;
  }

  return next;
}

// ============================================
// Draft Types
// ============================================

export interface ProjectDraft {
  name: string;
  summary: string;
  orgId: string;
  /** Markdown description */
  description: string;
  status: string;
  priority: string;
  health: string;
  leadId?: string;
  memberIds: string[];
  teamIds: string[];
  labelIds: string[];
  /**
   * File-system paths (or repo IDs) of repos linked to this project.
   * 0..N entries — repo linkage is optional and not exclusive.
   */
  linkedRepoPaths: string[];
  startDate?: string;
  targetDate?: string;
  schedule?: import("@src/api/http/project").WorkItemSchedule | null;
}

export interface WorkItemDraft {
  name: string;
  /** Rich-text description (HTML string) */
  description: string;
  status: string;
  priority: string;
  assigneeId?: string;
  assigneeType?: string;
  orchestratorConfig?: import("@src/api/http/project").OrchestratorConfig;
  projectId?: string;
  orgId?: string;
  milestoneId?: string;
  labelIds: string[];
  startDate?: string;
  targetDate?: string;
  schedule?: import("@src/api/http/project").WorkItemSchedule | null;
}

// ============================================
// Default Factories
// ============================================

export function createDefaultProjectDraft(): ProjectDraft {
  return {
    name: "",
    summary: "",
    orgId: "personal-org",
    description: "",
    status: "backlog",
    priority: "none",
    health: "no_updates",
    leadId: undefined,
    memberIds: [],
    teamIds: [],
    labelIds: [],
    linkedRepoPaths: [],
    startDate: undefined,
    targetDate: undefined,
  };
}

export function createDefaultWorkItemDraft(projectId?: string): WorkItemDraft {
  return {
    name: "",
    description: "",
    status: WORK_ITEM_STATUS.PLANNED,
    priority: "none",
    assigneeId: undefined,
    projectId,
    milestoneId: undefined,
    labelIds: [],
    startDate: undefined,
    targetDate: undefined,
  };
}

// ============================================
// Atoms
// ============================================

/** Map<tabId, ProjectDraft> — in-memory only, not persisted */
export const projectDraftsAtom = atom<Map<string, ProjectDraft>>(new Map());

/** Map<tabId, WorkItemDraft> — in-memory only, not persisted */
export const workItemDraftsAtom = atom<Map<string, WorkItemDraft>>(new Map());

// ============================================
// Write Atoms (with FIFO eviction)
// ============================================

/** Set or update a project draft for a given tab */
export const setProjectDraftAtom = atom(
  null,
  (get, set, { tabId, draft }: { tabId: string; draft: ProjectDraft }) => {
    const prev = get(projectDraftsAtom);
    set(projectDraftsAtom, writeDraftMapEntry(prev, tabId, draft));
  }
);

/** Merge partial updates into a project draft (reads latest atom value) */
export const patchProjectDraftAtom = atom(
  null,
  (
    get,
    set,
    { tabId, patch }: { tabId: string; patch: Partial<ProjectDraft> }
  ) => {
    const current =
      get(projectDraftsAtom).get(tabId) ?? createDefaultProjectDraft();
    set(setProjectDraftAtom, { tabId, draft: { ...current, ...patch } });
  }
);

/** Remove a project draft (e.g. after save or tab close) */
export const removeProjectDraftAtom = atom(null, (get, set, tabId: string) => {
  const prev = get(projectDraftsAtom);
  if (!prev.has(tabId)) return;
  const next = new Map(prev);
  next.delete(tabId);
  set(projectDraftsAtom, next);
});

/** Set or update a work item draft for a given tab */
export const setWorkItemDraftAtom = atom(
  null,
  (get, set, { tabId, draft }: { tabId: string; draft: WorkItemDraft }) => {
    const prev = get(workItemDraftsAtom);
    set(workItemDraftsAtom, writeDraftMapEntry(prev, tabId, draft));
  }
);

/** Merge partial updates into a work item draft (reads latest atom value) */
export const patchWorkItemDraftAtom = atom(
  null,
  (
    get,
    set,
    { tabId, patch }: { tabId: string; patch: Partial<WorkItemDraft> }
  ) => {
    const current =
      get(workItemDraftsAtom).get(tabId) ?? createDefaultWorkItemDraft();
    set(setWorkItemDraftAtom, { tabId, draft: { ...current, ...patch } });
  }
);

/** Remove a work item draft (e.g. after save or tab close) */
export const removeWorkItemDraftAtom = atom(null, (get, set, tabId: string) => {
  const prev = get(workItemDraftsAtom);
  if (!prev.has(tabId)) return;
  const next = new Map(prev);
  next.delete(tabId);
  set(workItemDraftsAtom, next);
});
