/**
 * Work item reads, writes, partial updates, handoff transitions and short-id
 * allocation, for both project-scoped and org-scoped standalone items.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "../cache";
import type {
  EnrichedWorkItem,
  WorkItemData,
  WorkItemFrontmatter,
  WorkItemHandoffTransition,
  WorkItemPartialUpdate,
  WorkItemsViewData,
  WorkspaceWorkItemsData,
} from "../types";
import {
  type ProjectScopeOptions,
  type WorkItemsReadOptions,
  scopeCacheSegment,
  scopeInvokePayload,
} from "./scope";

export async function readWorkItems(
  projectSlug: string,
  options?: ProjectScopeOptions
): Promise<WorkItemData[]> {
  const scopeSegment = scopeCacheSegment(options);
  return cachedRead(`${projectSlug}:workitems:${scopeSegment}`, () =>
    invoke("project_read_work_items", {
      projectSlug,
      ...scopeInvokePayload(options),
    })
  );
}

export async function readWorkItemsEnriched(
  projectSlug: string,
  options?: WorkItemsReadOptions
): Promise<EnrichedWorkItem[]> {
  const readBucket = options?.readBucket;
  if (readBucket) {
    return invoke("project_read_work_items_enriched", {
      projectSlug,
      ...scopeInvokePayload(options),
      readBucket,
    });
  }
  const scopeSegment = scopeCacheSegment(options);
  return cachedRead(`${projectSlug}:workitems-enriched:${scopeSegment}`, () =>
    invoke("project_read_work_items_enriched", {
      projectSlug,
      ...scopeInvokePayload(options),
      readBucket: null,
    })
  );
}

type WorkspaceWorkItemsWireData = Omit<
  WorkspaceWorkItemsData,
  "standaloneWorkItems"
> & {
  standaloneWorkItems: Array<
    Omit<WorkspaceWorkItemsData["standaloneWorkItems"][number], "workItem"> & {
      workItem: Omit<WorkItemData, "frontmatter"> & {
        frontmatter: Omit<WorkItemFrontmatter, "todos"> & {
          todos?: WorkItemFrontmatter["todos"];
        };
      };
    }
  >;
};

export async function readWorkspaceWorkItemsData(
  options?: WorkItemsReadOptions
): Promise<WorkspaceWorkItemsData> {
  const data = await invoke<WorkspaceWorkItemsWireData>(
    "project_read_workspace_work_items_data",
    {
      ...scopeInvokePayload(options),
      readBucket: options?.readBucket ?? null,
    }
  );

  // Empty Vec fields are omitted from standalone WorkItem frontmatter by
  // Rust's persisted-file serializer. Restore the required frontend shape at
  // the IPC boundary so consumers can safely treat todos as an array.
  return {
    ...data,
    standaloneWorkItems: data.standaloneWorkItems.map((entry) => ({
      ...entry,
      workItem: {
        ...entry.workItem,
        frontmatter: {
          ...entry.workItem.frontmatter,
          todos: entry.workItem.frontmatter.todos ?? [],
        },
      },
    })),
  };
}

/**
 * One-shot endpoint for the WorkItems page: enriched items + status
 * counts (computed before filtering, for the filter badges) + only the
 * requested view projection.
 *
 * Filter args bypass the cache so the dynamic search/status query
 * always hits Rust; the no-filter call is cached because it's the
 * common page-load path.
 */
export interface WorkItemsViewOptions extends ProjectScopeOptions {
  statusFilter?: string;
  searchQuery?: string;
  view?: "list" | "kanban" | "gantt" | "calendar";
}

export async function readWorkItemsViewData(
  projectSlug: string,
  options?: WorkItemsViewOptions
): Promise<WorkItemsViewData> {
  const { statusFilter, searchQuery, view } = options ?? {};
  const scopePayload = scopeInvokePayload(options);
  const scopeSegment = scopeCacheSegment(options);
  const hasFilters =
    (statusFilter && statusFilter !== "all") ||
    (searchQuery && searchQuery.trim());

  if (hasFilters) {
    return invoke("project_read_work_items_view_data", {
      projectSlug,
      ...scopePayload,
      statusFilter: statusFilter ?? null,
      searchQuery: searchQuery ?? null,
      view: view ?? null,
    });
  }

  return cachedRead(
    `${projectSlug}:workitems-view:${scopeSegment}:${view ?? "all"}`,
    () =>
      invoke("project_read_work_items_view_data", {
        projectSlug,
        ...scopePayload,
        statusFilter: null,
        searchQuery: null,
        view: view ?? null,
      })
  );
}

export async function readWorkItem(
  projectSlug: string,
  shortId: string,
  options?: ProjectScopeOptions
): Promise<WorkItemData> {
  return invoke<WorkItemData>("project_read_work_item", {
    projectSlug,
    shortId,
    ...scopeInvokePayload(options),
  });
}

export async function readWorkItemEnriched(
  projectSlug: string,
  shortId: string,
  options?: ProjectScopeOptions
): Promise<EnrichedWorkItem> {
  const scopeSegment = scopeCacheSegment(options);
  return cachedRead(
    `${projectSlug}:workitem-enriched:${shortId}:${scopeSegment}`,
    () =>
      invoke<EnrichedWorkItem>("project_read_work_item_enriched", {
        projectSlug,
        shortId,
        ...scopeInvokePayload(options),
      })
  );
}

export async function readStandaloneWorkItems(
  options?: WorkItemsReadOptions
): Promise<WorkItemData[]> {
  const readBucket = options?.readBucket;
  if (readBucket) {
    return invoke("work_item_read_standalone_items", {
      ...scopeInvokePayload(options),
      readBucket,
    });
  }
  const scopeSegment = scopeCacheSegment(options);
  return cachedRead(`standalone:workitems:${scopeSegment}`, () =>
    invoke("work_item_read_standalone_items", {
      ...scopeInvokePayload(options),
      readBucket: null,
    })
  );
}

export async function readStandaloneWorkItem(
  shortId: string,
  options?: ProjectScopeOptions
): Promise<WorkItemData> {
  return invoke<WorkItemData>("work_item_read_standalone_item", {
    shortId,
    ...scopeInvokePayload(options),
  });
}

/**
 * Creation DTO for the canonical `work.create` service operation.
 * Mirrors Rust `work_service::CreateWorkItemRequest` (camelCase wire).
 */
export interface WorkItemCreateRequest {
  title: string;
  body?: string;
  projectId?: string;
  status?: string;
  priority?: string;
  assignee?: string;
  assigneeType?: string;
  labels?: string[];
  milestone?: string;
  parent?: string;
  stage?: number;
  startDate?: string;
  targetDate?: string;
  createdBy?: string;
  starred?: boolean;
  schedule?: WorkItemFrontmatter["schedule"];
  orchestratorConfig?: WorkItemFrontmatter["orchestrator_config"];
  todos?: WorkItemFrontmatter["todos"];
  handoff?: WorkItemFrontmatter["handoff"];
  linkedSessions?: WorkItemFrontmatter["linked_sessions"];
}

/**
 * Canonical `work.create`: the service owns frontmatter construction;
 * callers describe the work and supply a pre-allocated short id (collab
 * orgs mint ids server-side). Prefer this over `writeWorkItem` for new
 * items — the whole-row write is reserved for sync/merge internals.
 */
export async function createWorkItem(
  projectSlug: string,
  shortId: string,
  request: WorkItemCreateRequest
): Promise<WorkItemData> {
  const result = await invoke<WorkItemData>("project_create_work_item", {
    projectSlug,
    shortId,
    request,
  });
  invalidateCache();
  return result;
}

/** Canonical `work.create` for an org-scoped standalone item. */
export async function createStandaloneWorkItem(
  shortId: string,
  request: WorkItemCreateRequest,
  options?: ProjectScopeOptions
): Promise<WorkItemData> {
  const result = await invoke<WorkItemData>("work_item_create_standalone", {
    ...scopeInvokePayload(options),
    shortId,
    request,
  });
  invalidateCache();
  return result;
}

export async function writeWorkItem(
  projectSlug: string,
  shortId: string,
  frontmatter: WorkItemFrontmatter,
  body: string
): Promise<void> {
  const result = await invoke<void>("project_write_work_item", {
    projectSlug,
    shortId,
    frontmatter,
    body,
  });
  invalidateCache();
  return result;
}

export async function writeStandaloneWorkItem(
  shortId: string,
  frontmatter: WorkItemFrontmatter,
  body: string,
  options?: ProjectScopeOptions
): Promise<void> {
  const result = await invoke<void>("work_item_write_standalone_item", {
    shortId,
    frontmatter,
    body,
    ...scopeInvokePayload(options),
  });
  invalidateCache();
  return result;
}

export async function deleteWorkItem(
  projectSlug: string,
  shortId: string
): Promise<void> {
  const result = await invoke<void>("project_delete_work_item", {
    projectSlug,
    shortId,
  });
  invalidateCache(projectSlug);
  return result;
}

export async function restoreWorkItem(
  projectSlug: string,
  shortId: string
): Promise<EnrichedWorkItem> {
  const result = await invoke<EnrichedWorkItem>("project_restore_work_item", {
    projectSlug,
    shortId,
  });
  invalidateCache(projectSlug);
  return result;
}

export async function purgeExpiredDeletedWorkItems(
  projectSlug: string
): Promise<number> {
  const result = await invoke<number>(
    "project_purge_expired_deleted_work_items",
    { projectSlug }
  );
  invalidateCache(projectSlug);
  return result;
}

/**
 * Atomic partial update; the Rust handler holds an `IMMEDIATE`
 * transaction across the read-modify-write so concurrent edits
 * serialize cleanly. Returns the enriched view so callers can sync
 * their UI state without a follow-up read.
 */
export async function updateWorkItemPartial(
  projectSlug: string,
  shortId: string,
  updates: WorkItemPartialUpdate
): Promise<EnrichedWorkItem> {
  const result = await invoke<EnrichedWorkItem>(
    "project_update_work_item_partial",
    {
      projectSlug,
      shortId,
      updates,
    }
  );
  invalidateCache();
  return result;
}

export async function updateStandaloneWorkItemPartial(
  shortId: string,
  updates: WorkItemPartialUpdate,
  options?: ProjectScopeOptions
): Promise<WorkItemData> {
  const result = await invoke<WorkItemData>(
    "work_item_update_standalone_partial",
    {
      ...scopeInvokePayload(options),
      shortId,
      updates,
    }
  );
  invalidateCache();
  return result;
}

export async function transitionWorkItemHandoff(
  projectSlug: string,
  shortId: string,
  transition: WorkItemHandoffTransition
): Promise<WorkItemData> {
  const result = await invoke<WorkItemData>(
    "project_transition_work_item_handoff",
    {
      projectSlug,
      shortId,
      transition,
    }
  );
  invalidateCache();
  return result;
}

export async function transitionStandaloneWorkItemHandoff(
  shortId: string,
  transition: WorkItemHandoffTransition,
  options?: ProjectScopeOptions
): Promise<WorkItemData> {
  const result = await invoke<WorkItemData>(
    "work_item_transition_standalone_handoff",
    {
      ...scopeInvokePayload(options),
      shortId,
      transition,
    }
  );
  invalidateCache();
  return result;
}

export async function moveWorkItem(
  shortId: string,
  fromProject: string,
  toProject: string
): Promise<void> {
  const result = await invoke<void>("project_move_work_item", {
    shortId,
    fromProject,
    toProject,
  });
  invalidateCache(fromProject);
  invalidateCache(toProject);
  return result;
}

export async function allocateWorkItemId(projectSlug: string): Promise<string> {
  return invoke("project_allocate_work_item_id", { projectSlug });
}

export async function allocateStandaloneWorkItemId(
  options?: ProjectScopeOptions
): Promise<string> {
  return invoke("work_item_allocate_standalone_id", {
    ...scopeInvokePayload(options),
  });
}
