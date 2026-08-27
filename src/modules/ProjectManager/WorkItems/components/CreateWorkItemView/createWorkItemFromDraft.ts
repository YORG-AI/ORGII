import {
  type LinkedSession,
  type TodoEntry,
  type WorkItemData,
  type WorkItemHandoff,
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

import { resolveHumanAssigneeWrite } from "../../humanAssignee";

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
  /** Durable provenance written in the same operation as the Work Item. */
  linkedSessions?: readonly LinkedSession[];
  /** Optional parsed checklist; ordinary composer creation still defaults empty. */
  todos?: readonly TodoEntry[];
  /** Optional human handoff written atomically with initial assignment. */
  handoff?: WorkItemHandoff;
  /** Human member that initiated this creation. */
  createdByMemberId?: string;
}

export async function createWorkItemFromDraft({
  createMore = false,
  defaultTitle,
  description,
  draft,
  linkedSessions,
  handoff,
  createdByMemberId,
  orgId,
  selectedProjectSlug,
  todos,
}: CreateWorkItemFromDraftOptions): Promise<CreatedWorkItemResult> {
  const title = draft.name.trim() || defaultTitle?.trim();
  if (!title) {
    throw new Error("Work item title is required");
  }

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
  const humanAssignment = resolveHumanAssigneeWrite(
    draft.assigneeId,
    draft.assigneeType
  );

  // Canonical work.create: the Rust service owns row construction.
  const request = {
    title,
    body: descriptionText,
    projectId: draft.projectId,
    status: draft.status || WORK_ITEM_STATUS.PLANNED,
    priority: draft.priority || "none",
    ...humanAssignment,
    labels: draft.labelIds,
    milestone: draft.milestoneId,
    startDate: draft.startDate,
    targetDate: draft.targetDate,
    createdBy: createdByMemberId,
    todos: todos ? [...todos] : undefined,
    handoff,
    linkedSessions: linkedSessions ? [...linkedSessions] : undefined,
    orchestratorConfig: draft.orchestratorConfig,
    schedule: draft.schedule ?? undefined,
  };

  const standaloneOrgId = selectedProjectSlug ? undefined : targetOrgId;
  const item: WorkItemData = selectedProjectSlug
    ? await projectApi.createWorkItem(selectedProjectSlug, shortId, request)
    : await projectApi.createStandaloneWorkItem(
        shortId,
        request,
        standaloneOrgId ? { orgId: standaloneOrgId } : undefined
      );

  return {
    keepOpen: createMore,
    shortId,
    projectSlug: selectedProjectSlug,
    orgId: standaloneOrgId,
    item,
  };
}
