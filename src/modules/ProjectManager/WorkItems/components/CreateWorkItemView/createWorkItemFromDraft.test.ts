import { afterEach, describe, expect, it, vi } from "vitest";

import { projectApi } from "@src/api/http/project";
import {
  allocateCloudAwareStandaloneWorkItemId,
  allocateCloudAwareWorkItemId,
} from "@src/features/Org2Cloud/cloudShortId";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

import { createWorkItemFromDraft } from "./createWorkItemFromDraft";

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    createWorkItem: vi.fn(async () => undefined),
    createStandaloneWorkItem: vi.fn(async () => undefined),
  },
}));

vi.mock("@src/features/Org2Cloud/cloudShortId", () => ({
  allocateCloudAwareWorkItemId: vi.fn(async () => "PRJ-0001"),
  allocateCloudAwareStandaloneWorkItemId: vi.fn(async () => "WI-0001"),
}));

// Pulls in @tauri-apps/api/core at module load; the storage direction is
// an identity transform for drafts without asset references anyway.
vi.mock("@src/modules/ProjectManager/shared/utils/workItemImagePaths", () => ({
  unresolveImagePathsForStorage: (markdown: string) => markdown,
}));

const projectApiMock = vi.mocked(projectApi);
const allocateProjectIdMock = vi.mocked(allocateCloudAwareWorkItemId);
const allocateStandaloneIdMock = vi.mocked(
  allocateCloudAwareStandaloneWorkItemId
);

const DRAFT: WorkItemDraft = {
  name: "Ship the fix",
  description: "details",
  status: "planned",
  priority: "none",
  labelIds: [],
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("createWorkItemFromDraft", () => {
  it("routes project-scoped creation through the collab-aware project allocator", async () => {
    const result = await createWorkItemFromDraft({
      draft: DRAFT,
      selectedProjectSlug: "proj",
      // Surface org must be ignored: the project path resolves the org
      // from the project row itself.
      orgId: "porg-1",
    });

    expect(allocateProjectIdMock).toHaveBeenCalledWith("proj");
    expect(allocateStandaloneIdMock).not.toHaveBeenCalled();
    expect(projectApiMock.createWorkItem).toHaveBeenCalledWith(
      "proj",
      "PRJ-0001",
      expect.objectContaining({ title: "Ship the fix", body: "details" })
    );
    expect(projectApiMock.createStandaloneWorkItem).not.toHaveBeenCalled();
    expect(result.orgId).toBeUndefined();
    expect(result.projectSlug).toBe("proj");
  });

  it("stamps the surface org on standalone creation so collab orgs sync it", async () => {
    const result = await createWorkItemFromDraft({
      draft: DRAFT,
      orgId: "porg-1",
    });

    expect(allocateStandaloneIdMock).toHaveBeenCalledWith("porg-1");
    expect(projectApiMock.createStandaloneWorkItem).toHaveBeenCalledWith(
      "WI-0001",
      expect.objectContaining({ title: "Ship the fix", body: "details" }),
      { orgId: "porg-1" }
    );
    expect(projectApiMock.createWorkItem).not.toHaveBeenCalled();
    // Callers selecting the created item must carry the org, or a later
    // standalone re-write re-homes the row to personal-org.
    expect(result.orgId).toBe("porg-1");
  });

  it("prefers the draft-picked org over the surface org for standalone creation", async () => {
    const result = await createWorkItemFromDraft({
      draft: { ...DRAFT, orgId: "porg-picked" },
      orgId: "porg-surface",
    });

    expect(allocateStandaloneIdMock).toHaveBeenCalledWith("porg-picked");
    expect(projectApiMock.createStandaloneWorkItem).toHaveBeenCalledWith(
      "WI-0001",
      expect.objectContaining({ title: "Ship the fix", body: "details" }),
      { orgId: "porg-picked" }
    );
    expect(result.orgId).toBe("porg-picked");
  });

  it("treats a personal-org draft pick as no org and falls back to the surface org", async () => {
    const result = await createWorkItemFromDraft({
      draft: { ...DRAFT, orgId: "personal-org" },
      orgId: "porg-surface",
    });

    expect(allocateStandaloneIdMock).toHaveBeenCalledWith("porg-surface");
    expect(result.orgId).toBe("porg-surface");
  });

  it("writes unscoped when both the draft pick and surface org are personal", async () => {
    const result = await createWorkItemFromDraft({
      draft: { ...DRAFT, orgId: "personal-org" },
      orgId: "personal-org",
    });

    expect(allocateStandaloneIdMock).toHaveBeenCalledWith(undefined);
    expect(projectApiMock.createStandaloneWorkItem).toHaveBeenCalledWith(
      "WI-0001",
      expect.objectContaining({ title: "Ship the fix", body: "details" }),
      undefined
    );
    expect(result.orgId).toBeUndefined();
  });

  it("keeps the personal-org default when no surface org is given", async () => {
    const result = await createWorkItemFromDraft({ draft: DRAFT });

    expect(allocateStandaloneIdMock).toHaveBeenCalledWith(undefined);
    expect(projectApiMock.createStandaloneWorkItem).toHaveBeenCalledWith(
      "WI-0001",
      expect.objectContaining({ title: "Ship the fix", body: "details" }),
      undefined
    );
    expect(result.orgId).toBeUndefined();
  });

  it("rejects drafts without a resolvable title", async () => {
    await expect(
      createWorkItemFromDraft({ draft: { ...DRAFT, name: "  " } })
    ).rejects.toThrow("Work item title is required");
    expect(projectApiMock.createStandaloneWorkItem).not.toHaveBeenCalled();
  });

  it("persists linked session provenance atomically with creation", async () => {
    const linkedSession = {
      session_id: "session-1",
      session_type: "native" as const,
      agent_role: "custom" as const,
      started_at: "2026-07-28T00:00:00.000Z",
      status: "completed" as const,
      cost_usd: 0,
      total_tokens: 42,
    };

    await createWorkItemFromDraft({
      draft: DRAFT,
      linkedSessions: [linkedSession],
    });

    expect(projectApiMock.createStandaloneWorkItem).toHaveBeenCalledWith(
      "WI-0001",
      expect.objectContaining({ linkedSessions: [linkedSession] }),
      undefined
    );
  });

  it("writes human assignees and rejects agent identities from the assignment field", async () => {
    await createWorkItemFromDraft({
      draft: {
        ...DRAFT,
        assigneeId: "member-1",
        assigneeType: "human",
      },
    });
    expect(projectApiMock.createStandaloneWorkItem).toHaveBeenLastCalledWith(
      "WI-0001",
      expect.objectContaining({
        assignee: "member-1",
        assigneeType: "human",
      }),
      undefined
    );

    await createWorkItemFromDraft({
      draft: {
        ...DRAFT,
        assigneeId: "builtin:os",
        assigneeType: "agent",
      },
    });
    const latestRequest =
      projectApiMock.createStandaloneWorkItem.mock.calls.at(-1)?.[1];
    expect(latestRequest).not.toHaveProperty("assignee");
    expect(latestRequest).not.toHaveProperty("assigneeType");
  });
});
