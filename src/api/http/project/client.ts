/**
 * Project store Tauri client.
 *
 * Thin `invoke()` wrappers for the `project_*` commands. All calls
 * are slug-keyed — the old `repoPath` boundary is gone, and projects
 * are listed from the global store.
 */
import { invoke } from "@tauri-apps/api/core";

import { cachedRead, invalidateCache } from "./cache";
import type {
  BatchDeleteResult,
  BatchUpdateResult,
  CollabOutboxAckResult,
  CollabOutboxPushItem,
  CollabPendingEntity,
  CollabRemoteEntity,
  ConfigureProjectOrgGitFolderSyncRequest,
  CreateProjectOrgRequest,
  EnrichedWorkItem,
  LabelsFile,
  MembersFile,
  MilestonesFile,
  ProjectData,
  ProjectMeta,
  ProjectOrg,
  ResolveProjectOrgGitFolderConflictRequest,
  RoutineDefinition,
  RoutineFire,
  RoutineFireResult,
  SyncProjectOrgGitFolderRequest,
  SyncProjectOrgGitFolderResult,
  WorkItemData,
  WorkItemFrontmatter,
  WorkItemHandoffTransition,
  WorkItemPartialUpdate,
  WorkItemsViewData,
  WorkspaceWorkItemsData,
} from "./types";

// ============================================
// Init / discovery
// ============================================

/** Return the OS Agent personal workspace path (`~/.orgii/personal/workspace/`). */
export async function personalWorkspace(): Promise<string> {
  return invoke("project_personal_workspace");
}

// ============================================
// Orgs
// ============================================

export async function readOrgs(): Promise<ProjectOrg[]> {
  return cachedRead("__project_orgs__:list", () => invoke("project_read_orgs"));
}

export async function createOrg(
  request: CreateProjectOrgRequest
): Promise<ProjectOrg> {
  const result = await invoke<ProjectOrg>("project_create_org", { request });
  invalidateCache("__project_orgs__");
  return result;
}

export async function deleteOrg(orgId: string): Promise<void> {
  await invoke("project_delete_org", { orgId });
  invalidateCache("__project_orgs__");
  invalidateCache("__projects__");
}

export async function configureOrgGitFolderSync(
  request: ConfigureProjectOrgGitFolderSyncRequest
): Promise<ProjectOrg> {
  const result = await invoke<ProjectOrg>(
    "project_configure_org_git_folder_sync",
    {
      request,
    }
  );
  invalidateCache("__project_orgs__");
  return result;
}

export async function syncOrgGitFolder(
  request: SyncProjectOrgGitFolderRequest
): Promise<SyncProjectOrgGitFolderResult> {
  const result = await invoke<SyncProjectOrgGitFolderResult>(
    "project_sync_org_git_folder",
    {
      request,
    }
  );
  invalidateCache("__project_orgs__");
  invalidateCache("__projects__");
  return result;
}

export async function resolveOrgGitFolderConflict(
  request: ResolveProjectOrgGitFolderConflictRequest
): Promise<void> {
  return invoke("project_resolve_org_git_folder_conflict", { request });
}

// ============================================
// Collab sync bridge (design §16.8)
// ============================================

/**
 * Mark a local project org as backed by the orgii collab plane
 * (`source='collab'`, `sync_provider='orgii_collab'`). Local mutations
 * under the org start enqueueing orgii_collab outbox rows from here on.
 */
export async function configureOrgCollabSync(input: {
  orgId: string;
  externalOrgId?: string;
}): Promise<ProjectOrg> {
  const result = await invoke<ProjectOrg>("project_configure_org_collab_sync", {
    orgId: input.orgId,
    externalOrgId: input.externalOrgId ?? null,
  });
  invalidateCache("__project_orgs__");
  return result;
}

/**
 * Leave-org cleanup for a collab-aliased project org: purge every
 * orgii_collab outbox row for the org (worker rows are untouched) and
 * reverse the marking `configureOrgCollabSync` applied, in one Rust
 * transaction. Without it, the scrub's project deletions leave DELETE
 * tombstones that would drain on a later rejoin and destroy the org's
 * shared projects for everyone. Leaves the org row and its projects
 * alone — the leave flow owns the project purge.
 */
export async function collabLeaveCleanup(orgId: string): Promise<{
  deletedOutboxRows: number;
  orgUnmarked: boolean;
}> {
  const result = await invoke<{
    deletedOutboxRows: number;
    orgUnmarked: boolean;
  }>("project_collab_leave_cleanup", { orgId });
  invalidateCache("__project_orgs__");
  return result;
}

/** Claim + hydrate pending collab pushes for one local project org. */
export async function drainCollabOutbox(input: {
  orgId: string;
  max?: number;
}): Promise<CollabOutboxPushItem[]> {
  return invoke("project_collab_outbox_drain", {
    orgId: input.orgId,
    max: input.max ?? null,
  });
}

export async function listCollabOutboxPendingIds(
  orgId: string
): Promise<CollabPendingEntity[]> {
  return invoke("project_collab_outbox_pending_ids", { orgId });
}

/** Persist collab push outcomes (success / conflict-requeue / backoff). */
export async function ackCollabOutbox(
  results: CollabOutboxAckResult[]
): Promise<void> {
  return invoke("project_collab_outbox_ack", { results });
}

/**
 * Apply pulled server rows into the local store (per-field merged,
 * echo-free). Returns how many entities changed local state.
 */
export async function applyCollabRemote(input: {
  orgId: string;
  orgName?: string;
  entities: CollabRemoteEntity[];
}): Promise<number> {
  const applied = await invoke<number>("project_collab_apply_remote", {
    orgId: input.orgId,
    orgName: input.orgName ?? null,
    entities: input.entities,
  });
  if (applied > 0) {
    invalidateCache();
  }
  return applied;
}

// ============================================
// Projects
// ============================================

export interface ProjectScopeOptions {
  orgId?: string | null;
}

export type WorkItemReadBucket = "active" | "completed";

export interface WorkItemsReadOptions extends ProjectScopeOptions {
  readBucket?: WorkItemReadBucket;
}

function scopeCacheSegment(options?: ProjectScopeOptions): string {
  return options?.orgId ? `org:${options.orgId}` : "all";
}

function scopeInvokePayload(options?: ProjectScopeOptions): {
  orgId: string | null;
} {
  return { orgId: options?.orgId ?? null };
}

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

export async function deleteProject(slug: string): Promise<void> {
  const result = await invoke<void>("project_delete_project", { slug });
  invalidateCache(slug);
  invalidateCache("__projects__");
  return result;
}

// ============================================
// Labels
// ============================================

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

// ============================================
// Milestones
// ============================================

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

// ============================================
// Members
// ============================================

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
  return result;
}

// ============================================
// Work items
// ============================================

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

export async function readWorkspaceWorkItemsData(
  options?: WorkItemsReadOptions
): Promise<WorkspaceWorkItemsData> {
  return invoke("project_read_workspace_work_items_data", {
    ...scopeInvokePayload(options),
    readBucket: options?.readBucket ?? null,
  });
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

// ============================================
// Batch
// ============================================

export async function batchDeleteWorkItems(
  projectSlug: string,
  shortIds: string[]
): Promise<BatchDeleteResult> {
  const result = await invoke<BatchDeleteResult>(
    "project_batch_delete_work_items",
    { projectSlug, shortIds }
  );
  invalidateCache(projectSlug);
  return result;
}

export async function batchUpdateWorkItems(
  projectSlug: string,
  shortIds: string[],
  updates: WorkItemPartialUpdate
): Promise<BatchUpdateResult> {
  const result = await invoke<BatchUpdateResult>(
    "project_batch_update_work_items",
    { projectSlug, shortIds, updates }
  );
  invalidateCache(projectSlug);
  return result;
}

// ============================================
// Routines
// ============================================

export async function listRoutines(): Promise<RoutineDefinition[]> {
  return cachedRead("__routines__:list", () => invoke("project_list_routines"));
}

export async function readRoutine(id: string): Promise<RoutineDefinition> {
  return cachedRead(`__routines__:${id}`, () =>
    invoke("project_read_routine", { id })
  );
}

export async function upsertRoutine(
  routine: RoutineDefinition
): Promise<RoutineDefinition> {
  const result = await invoke<RoutineDefinition>("project_upsert_routine", {
    routine,
  });
  invalidateCache("__routines__");
  return result;
}

export async function deleteRoutine(id: string): Promise<boolean> {
  const result = await invoke<boolean>("project_delete_routine", { id });
  invalidateCache("__routines__");
  return result;
}

export async function listRoutineFires(
  routineId: string
): Promise<RoutineFire[]> {
  return cachedRead(`__routines__:${routineId}:fires`, () =>
    invoke("project_list_routine_fires", { routineId })
  );
}

/** A row from `pm_routine_runs` (portable Routine domain, orgtrack/v1). */
export interface RoutineRunSummary {
  id: string;
  routineName: string;
  routineRevision: number;
  scopeId: string;
  status: string;
  rootWorkItemId?: string | null;
  createdBy?: string | null;
  createdAt: number;
  updatedAt: number;
}

/** Per-run projection: run row + generated WorkItems' portable states. */
export interface RoutineRunStatus {
  id: string;
  routineName: string;
  routineRevision: number;
  snapshotHash: string;
  scopeId: string;
  status: string;
  rootWorkItemId?: string | null;
  workItems: Array<{
    shortId: string;
    title: string;
    status: string;
    portableState?: string | null;
  }>;
}

/** List portable routine runs, newest first. Uncached: run status moves
 *  with work-item transitions, and the surface refetches on focus. */
export async function listRoutineRuns(options?: {
  scopeId?: string;
  limit?: number;
}): Promise<RoutineRunSummary[]> {
  return invoke("project_list_routine_runs", {
    scopeId: options?.scopeId ?? null,
    limit: options?.limit,
  });
}

export async function routineRunStatus(
  runId: string
): Promise<RoutineRunStatus> {
  return invoke("project_routine_run_status", { runId });
}

export async function fireRoutine(
  routineId: string
): Promise<RoutineFireResult> {
  const result = await invoke<RoutineFireResult>("project_fire_routine", {
    routineId,
  });
  invalidateCache("__routines__");
  invalidateCache(`__routines__:${routineId}:fires`);
  return result;
}

// ============================================
// Assets
// ============================================

/**
 * Save a binary asset under `projects/{slug}/assets/{filename}`.
 * `base64Data` must be the bare base64 (no `data:` URL prefix).
 * Returns the relative path the frontend embeds in markdown.
 */
export async function saveAsset(
  projectSlug: string,
  filename: string,
  base64Data: string
): Promise<string> {
  return invoke("project_save_asset", {
    projectSlug,
    filename,
    base64Data,
  });
}

export async function deleteAsset(
  projectSlug: string,
  filename: string
): Promise<void> {
  return invoke("project_delete_asset", { projectSlug, filename });
}

export async function listAssets(projectSlug: string): Promise<string[]> {
  return invoke("project_list_assets", { projectSlug });
}

export async function resolveAssetPath(
  projectSlug: string,
  filename: string
): Promise<string> {
  return invoke("project_resolve_asset_path", { projectSlug, filename });
}
