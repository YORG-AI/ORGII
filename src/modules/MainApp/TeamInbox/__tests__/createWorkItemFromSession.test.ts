import { describe, expect, it, vi } from "vitest";

import type { Session } from "@src/store/session";

import {
  type CreateFromSessionDependencies,
  createWorkItemFromSession,
  linkedSessionSnapshot,
  sessionHandoffDraft,
  sessionWorkItemDescription,
  sessionWorkItemHandoff,
  sessionWorkItemTitle,
  sessionWorkItemTodos,
} from "../createWorkItemFromSession";

const SESSION: Session = {
  session_id: "session-1",
  status: "completed",
  created_at: "2026-07-28T00:00:00.000Z",
  updated_at: "2026-07-28T01:00:00.000Z",
  completed_at: "2026-07-28T01:00:00.000Z",
  name: "Fix Team Inbox",
  user_input: "Make Session drops create a Work Item.",
  category: "rust_agent",
  filesChanged: 3,
  linesAdded: 42,
  linesRemoved: 7,
  touchedFiles: ["src/a.ts", "src/b.ts"],
  totalTokens: 99,
};

function dependencies(): CreateFromSessionDependencies & {
  create: ReturnType<typeof vi.fn>;
  link: ReturnType<typeof vi.fn>;
  readProjects: ReturnType<typeof vi.fn>;
  readProjectWorkItems: ReturnType<typeof vi.fn>;
  readStandaloneWorkItems: ReturnType<typeof vi.fn>;
  updateProjectWorkItem: ReturnType<typeof vi.fn>;
} {
  return {
    create: vi.fn(async () => ({
      shortId: "WI-0001",
      item: undefined,
    })),
    link: vi.fn(async () => ({ session_id: "session-1" })),
    readProjects: vi.fn(async () => []),
    readProjectWorkItems: vi.fn(async () => []),
    readStandaloneWorkItems: vi.fn(async () => []),
    updateProjectWorkItem: vi.fn(async () => undefined),
  };
}

describe("Session to Work Item mapping", () => {
  it("builds a bounded title and a linked Markdown snapshot", () => {
    expect(sessionWorkItemTitle(SESSION, "  Dragged title  ")).toBe(
      "Dragged title"
    );
    expect(sessionWorkItemDescription(SESSION, "Dragged title")).toContain(
      "[Dragged title](session://session-1)"
    );
    expect(sessionWorkItemDescription(SESSION, "Dragged title")).toContain(
      "3 files changed · +42 · −7"
    );
    expect(linkedSessionSnapshot(SESSION)).toMatchObject({
      session_id: "session-1",
      session_type: "native",
      status: "completed",
      total_tokens: 99,
    });
  });

  it("parses explicit Markdown checkboxes without inventing tasks", () => {
    expect(
      sessionWorkItemTodos({
        ...SESSION,
        user_input: [
          "Ship this change",
          "- [ ] Verify the drop target",
          "- [x] Confirm the source link",
          "- ordinary context",
        ].join("\n"),
      })
    ).toEqual([
      {
        id: "session-2",
        content: "Verify the drop target",
        status: "pending",
      },
      {
        id: "session-3",
        content: "Confirm the source link",
        status: "completed",
      },
    ]);
  });

  it("creates a standalone assigned Work Item with atomic provenance", async () => {
    const deps = dependencies();
    const result = await createWorkItemFromSession(
      {
        session: SESSION,
        title: "Dragged title",
        assigneeMemberId: "member-1",
        destination: { kind: "cloud_org", orgId: "org-1" },
        status: "in_progress",
        priority: "high",
        targetDate: "2026-08-01T00:00:00.000Z",
      },
      deps
    );

    expect(deps.create).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          assigneeId: "member-1",
          orgId: "org-1",
          status: "in_progress",
          priority: "high",
          targetDate: "2026-08-01T00:00:00.000Z",
        }),
        linkedSessions: [expect.objectContaining({ session_id: "session-1" })],
      })
    );
    expect(deps.link).not.toHaveBeenCalled();
    expect(result).toEqual({
      orgId: "org-1",
      projectId: "",
      workItemId: "WI-0001",
      reused: false,
    });
  });

  it("writes a cloud handoff into the selected org instead of the Session origin", async () => {
    const deps = dependencies();
    const result = await createWorkItemFromSession(
      {
        session: {
          ...SESSION,
          orgId: "origin-org",
          projectId: "local-project-id",
          projectSlug: "local-project",
        },
        destination: {
          kind: "cloud_org",
          orgId: "destination-org",
        },
        assigneeMemberId: "cloud-member-2",
      },
      deps
    );

    expect(deps.readStandaloneWorkItems).toHaveBeenCalledWith({
      orgId: "destination-org",
    });
    expect(deps.readProjects).not.toHaveBeenCalled();
    expect(deps.readProjectWorkItems).not.toHaveBeenCalled();
    expect(deps.create).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          assigneeId: "cloud-member-2",
          assigneeType: "member",
          orgId: "destination-org",
        }),
        orgId: "destination-org",
        selectedProjectSlug: undefined,
      })
    );
    expect(result).toMatchObject({
      orgId: "destination-org",
      projectId: "",
    });
  });

  it("builds a review draft without changing the Session", () => {
    const draft = sessionHandoffDraft(
      {
        ...SESSION,
        user_input: [
          "Investigate the failed sync.",
          "- [ ] Add a regression test",
        ].join("\n"),
      },
      [
        {
          kind: "project",
          key: "project:platform",
          projectId: "project-1",
          projectSlug: "platform",
          name: "Platform",
          sender: { id: "member-me", name: "Me", isCurrentUser: true },
          recipients: [
            { id: "member-me", name: "Me", isCurrentUser: true },
            { id: "member-lin", name: "Lin", isCurrentUser: false },
          ],
        },
      ],
      "Sync follow-up",
      "project:platform"
    );

    expect(draft).toMatchObject({
      sessionId: "session-1",
      title: "Sync follow-up",
      sourceDestinationKey: "project:platform",
      todoCount: 1,
      destinations: [
        {
          projectSlug: "platform",
          sender: { id: "member-me" },
          recipients: [{ id: "member-me" }, { id: "member-lin" }],
        },
      ],
    });
    expect(SESSION.user_input).toBe("Make Session drops create a Work Item.");
  });

  it("persists a teammate handoff in the same initial Work Item write", async () => {
    const deps = dependencies();
    await createWorkItemFromSession(
      {
        session: SESSION,
        title: "Continue the investigation",
        assigneeMemberId: "member-lin",
        assigneeMemberName: "Lin",
        senderMemberId: "member-me",
        senderMemberName: "Me",
        handoffNote: "The failing path is isolated.",
      },
      deps
    );

    const createOptions = deps.create.mock.calls[0]?.[0];
    expect(createOptions).toMatchObject({
      createdByMemberId: "member-me",
      draft: { assigneeId: "member-lin" },
      handoff: {
        id: expect.stringMatching(/^session-handoff:session-1:member-lin:/),
        status: "pending",
        senderMemberId: "member-me",
        senderName: "Me",
        recipientMemberId: "member-lin",
        recipientName: "Lin",
        note: "The failing path is isolated.",
      },
    });
  });

  it("does not create a handoff state when assigning the draft to self", () => {
    expect(
      sessionWorkItemHandoff({
        session: SESSION,
        assigneeMemberId: "member-me",
        senderMemberId: "member-me",
      })
    ).toBeUndefined();
  });

  it("does not create a handoff between aliases of the current user", () => {
    expect(
      sessionWorkItemHandoff({
        session: SESSION,
        assigneeMemberId: "member-alias",
        senderMemberId: "member-me",
        recipientIsCurrentUser: true,
      })
    ).toBeUndefined();
  });

  it("reuses a previously linked standalone item instead of duplicating it", async () => {
    const deps = dependencies();
    deps.readStandaloneWorkItems.mockResolvedValue([
      {
        filename: "WI-0042.md",
        body: "",
        frontmatter: {
          id: "WI-0042",
          short_id: "WI-0042",
          title: "Existing",
          status: "planned",
          priority: "none",
          labels: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          starred: false,
          todos: [],
          linked_sessions: [linkedSessionSnapshot(SESSION)],
        },
      },
    ]);

    const result = await createWorkItemFromSession({ session: SESSION }, deps);

    expect(deps.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      orgId: "personal-org",
      projectId: "",
      workItemId: "WI-0042",
      reused: true,
    });
  });

  it("reuses and repairs a project Work Item link after a partial failure", async () => {
    const deps = dependencies();
    deps.readProjects.mockResolvedValue([
      {
        slug: "inbox",
        description: "",
        meta: {
          id: "project-1",
          name: "Inbox",
          org_id: "org-1",
          status: "active",
          priority: "none",
          health: "no_updates",
          members: [],
          labels: [],
          linked_repos: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          next_work_item_id: 2,
          work_item_prefix: "INB",
          work_item_prefix_custom: false,
        },
      },
    ]);
    deps.readProjectWorkItems.mockResolvedValue([
      {
        filename: "INB-0001.md",
        body: "",
        frontmatter: {
          id: "INB-0001",
          short_id: "INB-0001",
          title: "Existing",
          project: "project-1",
          status: "planned",
          priority: "none",
          labels: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          starred: false,
          todos: [],
          linked_sessions: [linkedSessionSnapshot(SESSION)],
        },
      },
    ]);

    const result = await createWorkItemFromSession(
      {
        session: { ...SESSION, projectId: "project-1" },
      },
      deps
    );

    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.updateProjectWorkItem).not.toHaveBeenCalled();
    expect(deps.link).toHaveBeenCalledWith({
      sessionId: "session-1",
      projectSlug: "inbox",
      workItemId: "INB-0001",
      agentRole: "custom",
    });
    expect(result).toEqual({
      orgId: "org-1",
      projectId: "inbox",
      workItemId: "INB-0001",
      reused: true,
    });
  });

  it("applies a new teammate handoff when reusing a linked project item", async () => {
    const deps = dependencies();
    deps.readProjects.mockResolvedValue([
      {
        slug: "inbox",
        description: "",
        meta: {
          id: "project-1",
          name: "Inbox",
          org_id: "org-1",
          status: "active",
          priority: "none",
          health: "no_updates",
          members: [],
          labels: [],
          linked_repos: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          next_work_item_id: 2,
          work_item_prefix: "INB",
          work_item_prefix_custom: false,
        },
      },
    ]);
    deps.readProjectWorkItems.mockResolvedValue([
      {
        filename: "INB-0001.md",
        body: "",
        frontmatter: {
          id: "INB-0001",
          short_id: "INB-0001",
          title: "Existing",
          project: "project-1",
          status: "planned",
          priority: "none",
          assignee: "member-me",
          assignee_type: "member",
          labels: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          starred: false,
          todos: [],
          linked_sessions: [linkedSessionSnapshot(SESSION)],
        },
      },
    ]);

    await createWorkItemFromSession(
      {
        session: { ...SESSION, projectId: "project-1" },
        assigneeMemberId: "member-lin",
        assigneeMemberName: "Lin",
        senderMemberId: "member-me",
        senderMemberName: "Me",
        handoffNote: "Continue from the isolated failure.",
      },
      deps
    );

    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.updateProjectWorkItem).toHaveBeenCalledWith(
      "inbox",
      "INB-0001",
      expect.objectContaining({
        assignee: "member-lin",
        assigneeType: "member",
        actor: { id: "member-me", name: "Me" },
        handoff: expect.objectContaining({
          id: expect.stringMatching(/^session-handoff:session-1:member-lin:/),
          status: "pending",
          recipientMemberId: "member-lin",
        }),
      })
    );
  });

  it("starts a new handoff episode after a matching handoff was resolved", async () => {
    const deps = dependencies();
    const acceptedAt = "2026-07-28T02:00:00.000Z";
    const acceptedHandoff = {
      id: `session-handoff:session-1:member-lin:${SESSION.updated_at}`,
      status: "accepted" as const,
      senderMemberId: "member-me",
      senderName: "Me",
      recipientMemberId: "member-lin",
      recipientName: "Lin",
      requestedAt: SESSION.updated_at,
      respondedAt: acceptedAt,
    };
    deps.readProjects.mockResolvedValue([
      {
        slug: "inbox",
        description: "",
        meta: {
          id: "project-1",
          name: "Inbox",
          org_id: "org-1",
          status: "active",
          priority: "none",
          health: "no_updates",
          members: [],
          labels: [],
          linked_repos: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          next_work_item_id: 2,
          work_item_prefix: "INB",
          work_item_prefix_custom: false,
        },
      },
    ]);
    deps.readProjectWorkItems.mockResolvedValue([
      {
        filename: "INB-0001.md",
        body: "",
        frontmatter: {
          id: "INB-0001",
          short_id: "INB-0001",
          title: "Existing",
          project: "project-1",
          status: "planned",
          priority: "none",
          assignee: "member-lin",
          assignee_type: "member",
          labels: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          starred: false,
          todos: [],
          handoff: acceptedHandoff,
          linked_sessions: [linkedSessionSnapshot(SESSION)],
        },
      },
    ]);

    await createWorkItemFromSession(
      {
        session: { ...SESSION, projectId: "project-1" },
        assigneeMemberId: "member-lin",
        assigneeMemberName: "Lin",
        senderMemberId: "member-me",
        senderMemberName: "Me",
      },
      deps
    );

    expect(deps.updateProjectWorkItem).toHaveBeenCalledWith(
      "inbox",
      "INB-0001",
      expect.objectContaining({
        handoff: expect.objectContaining({
          id: expect.stringMatching(/^session-handoff:session-1:member-lin:/),
          status: "pending",
          recipientMemberId: "member-lin",
        }),
      })
    );
    const nextHandoff = deps.updateProjectWorkItem.mock.calls[0]?.[2]?.handoff;
    expect(nextHandoff?.id).not.toBe(acceptedHandoff.id);
  });

  it("preserves an equivalent pending handoff during idempotent retry", async () => {
    const deps = dependencies();
    const pendingHandoff = {
      id: `session-handoff:session-1:member-lin:${SESSION.updated_at}`,
      status: "pending" as const,
      senderMemberId: "member-me",
      senderName: "Me",
      recipientMemberId: "member-lin",
      recipientName: "Lin",
      requestedAt: SESSION.updated_at,
    };
    deps.readProjects.mockResolvedValue([
      {
        slug: "inbox",
        description: "",
        meta: {
          id: "project-1",
          name: "Inbox",
          org_id: "org-1",
          status: "active",
          priority: "none",
          health: "no_updates",
          members: [],
          labels: [],
          linked_repos: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          next_work_item_id: 2,
          work_item_prefix: "INB",
          work_item_prefix_custom: false,
        },
      },
    ]);
    deps.readProjectWorkItems.mockResolvedValue([
      {
        filename: "INB-0001.md",
        body: "",
        frontmatter: {
          id: "INB-0001",
          short_id: "INB-0001",
          title: "Existing",
          project: "project-1",
          status: "planned",
          priority: "none",
          assignee: "member-lin",
          assignee_type: "member",
          labels: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          starred: false,
          todos: [],
          handoff: pendingHandoff,
          linked_sessions: [linkedSessionSnapshot(SESSION)],
        },
      },
    ]);

    await createWorkItemFromSession(
      {
        session: { ...SESSION, projectId: "project-1" },
        assigneeMemberId: "member-lin",
        assigneeMemberName: "Lin",
        senderMemberId: "member-me",
        senderMemberName: "Me",
      },
      deps
    );

    expect(deps.updateProjectWorkItem).not.toHaveBeenCalled();
  });

  it("does not reuse a standalone Work Item id inside a selected project", async () => {
    const deps = dependencies();
    deps.readProjects.mockResolvedValue([
      {
        slug: "inbox",
        description: "",
        meta: {
          id: "project-1",
          name: "Inbox",
          org_id: "org-1",
          status: "active",
          priority: "none",
          health: "no_updates",
          members: [],
          labels: [],
          linked_repos: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          next_work_item_id: 2,
          work_item_prefix: "INB",
          work_item_prefix_custom: false,
        },
      },
    ]);

    const result = await createWorkItemFromSession(
      {
        session: { ...SESSION, workItemId: "STANDALONE-1" },
        destination: { kind: "project", projectSlug: "inbox" },
        assigneeMemberId: "member-lin",
      },
      deps
    );

    expect(deps.create).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ workItemId: "WI-0001", reused: false });
  });

  it("creates an unscoped Session handoff in the explicitly selected project", async () => {
    const deps = dependencies();
    deps.readProjects.mockResolvedValue([
      {
        slug: "inbox",
        description: "",
        meta: {
          id: "project-1",
          name: "Inbox",
          org_id: "org-1",
          status: "active",
          priority: "none",
          health: "no_updates",
          members: [],
          labels: [],
          linked_repos: [],
          created_at: SESSION.created_at,
          updated_at: SESSION.updated_at,
          next_work_item_id: 2,
          work_item_prefix: "INB",
          work_item_prefix_custom: false,
        },
      },
    ]);

    const result = await createWorkItemFromSession(
      {
        session: SESSION,
        destination: { kind: "project", projectSlug: "inbox" },
        assigneeMemberId: "member-lin",
      },
      deps
    );

    expect(deps.create).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          projectId: "project-1",
          assigneeId: "member-lin",
        }),
        selectedProjectSlug: "inbox",
      })
    );
    expect(deps.link).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        projectSlug: "inbox",
        workItemId: "WI-0001",
      })
    );
    expect(result.projectId).toBe("inbox");
  });

  it("does not silently move a project Session into standalone scope", async () => {
    const deps = dependencies();

    await expect(
      createWorkItemFromSession(
        {
          session: { ...SESSION, projectId: "missing-project" },
        },
        deps
      )
    ).rejects.toThrow("Session project is no longer available");

    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.readStandaloneWorkItems).not.toHaveBeenCalled();
  });
});
