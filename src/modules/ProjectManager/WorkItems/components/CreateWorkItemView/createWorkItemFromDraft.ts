import {
  type WorkItemData,
  type WorkItemFrontmatter,
  projectApi,
} from "@src/api/http/project";
import {
  allocateCloudAwareStandaloneWorkItemId,
  allocateCloudAwareWorkItemId,
} from "@src/features/Org2Cloud/cloudShortId";
import { unresolveImagePathsForStorage } from "@src/modules/ProjectManager/shared/utils/workItemImagePaths";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";
import {
  WORK_ITEM_STATUS,
  type WorkItem as WorkItemExtended,
} from "@src/types/core/workItem";

export interface CreatedWorkItemResult {
  keepOpen?: boolean;
  shortId: string;
  projectSlug?: string;
  /**
   * Project-org id the item was written under. Set only for STANDALONE
   * creations that were stamped with a surface org — callers selecting the
   * created item must carry it, or a later standalone re-write would
   * re-home the row to `personal-org` (the Rust upsert overwrites
   * `org_id` on conflict) and detach it from collab sync.
   */
  orgId?: string;
  item?: WorkItemData;
  workItem?: WorkItemExtended;
}

export interface CreateWorkItemFromDraftOptions {
  createMore?: boolean;
  defaultTitle?: string;
  description?: string;
  draft: WorkItemDraft;
  selectedProjectSlug?: string;
  /**
   * Project-org id of the surface the creation happens in (for collab
   * orgs this is the aliased `projectOrgId ?? id`). Only consulted for
   * STANDALONE creation (no `selectedProjectSlug`): the item is written
   * under that org so a collab-synced org picks it up (outbox → push).
   * Omit for true personal items — the backend defaults to
   * `personal-org`, which never syncs. Project-scoped creation ignores
   * this and resolves the org from the project row.
   */
  orgId?: string | null;
}

export async function createWorkItemFromDraft({
  createMore = false,
  defaultTitle,
  description,
  draft,
  orgId,
  selectedProjectSlug,
}: CreateWorkItemFromDraftOptions): Promise<CreatedWorkItemResult> {
  const title = draft.name.trim() || defaultTitle?.trim();
  if (!title) {
    throw new Error("Work item title is required");
  }

  const now = new Date().toISOString();
  const descriptionText = unresolveImagePathsForStorage(
    (description ?? draft.description).trim()
  );
  // Collab-synced orgs allocate on the server (design §16.5) with a
  // local-counter fallback when offline; everything else stays local.
  // Standalone items have no project row, so they use the org-scoped
  // local counter (see allocateCloudAwareStandaloneWorkItemId for the
  // documented residual under a collab org).
  const pickedOrgId =
    draft.orgId && draft.orgId !== "personal-org" ? draft.orgId : undefined;
  const surfaceOrgId = orgId && orgId !== "personal-org" ? orgId : undefined;
  const targetOrgId = pickedOrgId ?? surfaceOrgId;
  const shortId = selectedProjectSlug
    ? await allocateCloudAwareWorkItemId(selectedProjectSlug)
    : await allocateCloudAwareStandaloneWorkItemId(targetOrgId);
  const frontmatter: WorkItemFrontmatter = {
    id: shortId,
    short_id: shortId,
    title,
    project: draft.projectId,
    status: draft.status || WORK_ITEM_STATUS.PLANNED,
    priority: draft.priority || "none",
    assignee: draft.assigneeId,
    assignee_type: draft.assigneeType,
    labels: draft.labelIds,
    milestone: draft.milestoneId,
    start_date: draft.startDate,
    target_date: draft.targetDate,
    created_by: undefined,
    created_at: now,
    updated_at: now,
    starred: false,
    todos: [],
    orchestrator_config: draft.orchestratorConfig,
    schedule: draft.schedule ?? undefined,
  };

  const standaloneOrgId = selectedProjectSlug ? undefined : targetOrgId;
  if (selectedProjectSlug) {
    await projectApi.writeWorkItem(
      selectedProjectSlug,
      shortId,
      frontmatter,
      descriptionText
    );
  } else {
    await projectApi.writeStandaloneWorkItem(
      shortId,
      frontmatter,
      descriptionText,
      standaloneOrgId ? { orgId: standaloneOrgId } : undefined
    );
  }

  return {
    keepOpen: createMore,
    shortId,
    projectSlug: selectedProjectSlug,
    orgId: standaloneOrgId,
    item: {
      frontmatter,
      body: descriptionText,
      filename: `${shortId}.md`,
    },
  };
}
