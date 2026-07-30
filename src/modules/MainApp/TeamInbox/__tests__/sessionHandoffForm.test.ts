import { describe, expect, it } from "vitest";

import type { TeamInboxSessionHandoffDraft } from "../domain";
import {
  createSessionHandoffForm,
  isTeamHandoff,
  normalizedSessionHandoffForm,
  sessionHandoffFormError,
  sessionHandoffFormForDestination,
  sessionHandoffFormToWorkItem,
  sessionHandoffFormWithWorkItemUpdates,
} from "../sessionHandoffForm";

function draft(
  overrides: Partial<TeamInboxSessionHandoffDraft> = {}
): TeamInboxSessionHandoffDraft {
  return {
    sessionId: "session-1",
    title: "Investigate sync",
    sourceDestinationKey: "project:project-alpha",
    destinations: [
      {
        kind: "project",
        key: "project:project-alpha",
        projectId: "project-1",
        projectSlug: "project-alpha",
        name: "Project Alpha",
        sender: {
          id: "member-me",
          name: "Me",
          isCurrentUser: true,
        },
        recipients: [
          { id: "member-lin", name: "Lin", isCurrentUser: false },
          { id: "member-me", name: "Me", isCurrentUser: true },
        ],
      },
    ],
    todoCount: 2,
    ...overrides,
  };
}

const WORK_ITEM_PROPERTIES = {
  status: "planned" as const,
  priority: "none" as const,
  targetDate: "",
};

describe("sessionHandoffForm", () => {
  it("defaults to the current user to prevent accidental handoff", () => {
    expect(createSessionHandoffForm(draft())).toEqual({
      title: "Investigate sync",
      destinationKey: "project:project-alpha",
      assigneeMemberId: "member-me",
      ...WORK_ITEM_PROPERTIES,
      note: "",
    });
  });

  it("distinguishes self creation from a team handoff", () => {
    const model = draft();
    expect(isTeamHandoff(createSessionHandoffForm(model), model)).toBe(false);
    expect(
      isTeamHandoff(
        {
          ...WORK_ITEM_PROPERTIES,
          title: model.title,
          destinationKey: "project:project-alpha",
          assigneeMemberId: "member-lin",
          note: "",
        },
        model
      )
    ).toBe(true);
  });

  it("uses the active Cloud Org roster and exact signed-in account identity", () => {
    const model = draft({
      sourceDestinationKey: "cloud-org:org-invite-test",
      destinations: [
        {
          kind: "cloud_org",
          key: "cloud-org:org-invite-test",
          orgId: "org-invite-test",
          name: "ORG2-Invite-Test",
          sender: {
            id: "1106510024",
            name: "1106510024",
            isCurrentUser: true,
          },
          recipients: [
            {
              id: "1106510024",
              name: "1106510024",
              isCurrentUser: true,
            },
            {
              id: "ahanafish",
              name: "ahanafish",
              isCurrentUser: false,
            },
          ],
        },
      ],
    });

    expect(createSessionHandoffForm(model)).toEqual({
      title: "Investigate sync",
      destinationKey: "cloud-org:org-invite-test",
      assigneeMemberId: "1106510024",
      ...WORK_ITEM_PROPERTIES,
      note: "",
    });
    expect(
      isTeamHandoff(
        {
          ...WORK_ITEM_PROPERTIES,
          title: model.title,
          destinationKey: "cloud-org:org-invite-test",
          assigneeMemberId: "ahanafish",
          note: "",
        },
        model
      )
    ).toBe(true);
  });

  it("treats another current-user alias as self assignment", () => {
    const model = draft({
      destinations: [
        {
          kind: "project",
          key: "project:project-alpha",
          projectId: "project-1",
          projectSlug: "project-alpha",
          name: "Project Alpha",
          sender: {
            id: "member-me",
            name: "Me",
            isCurrentUser: true,
          },
          recipients: [
            { id: "member-me", name: "Me", isCurrentUser: true },
            {
              id: "member-alias",
              name: "Me (work)",
              isCurrentUser: true,
            },
            { id: "member-lin", name: "Lin", isCurrentUser: false },
          ],
        },
      ],
    });
    expect(
      isTeamHandoff(
        {
          ...WORK_ITEM_PROPERTIES,
          title: model.title,
          destinationKey: "project:project-alpha",
          assigneeMemberId: "member-alias",
          note: "",
        },
        model
      )
    ).toBe(false);
  });

  it("rejects blank titles and stale recipients", () => {
    const model = draft();
    expect(
      sessionHandoffFormError(
        {
          ...WORK_ITEM_PROPERTIES,
          title: " ",
          destinationKey: "project:project-alpha",
          assigneeMemberId: "member-me",
          note: "",
        },
        model
      )
    ).toBe("title_required");
    expect(
      sessionHandoffFormError(
        {
          ...WORK_ITEM_PROPERTIES,
          title: "Valid",
          destinationKey: "project:project-alpha",
          assigneeMemberId: "removed",
          note: "",
        },
        model
      )
    ).toBe("recipient_unavailable");
  });

  it("requires an explicit destination when an unscoped Session has multiple projects", () => {
    const model = draft({
      sourceDestinationKey: undefined,
      destinations: [
        ...draft().destinations,
        {
          kind: "project",
          key: "project:project-beta",
          projectId: "project-2",
          projectSlug: "project-beta",
          name: "Project Beta",
          sender: {
            id: "member-me-beta",
            name: "Me",
            isCurrentUser: true,
          },
          recipients: [
            { id: "member-me-beta", name: "Me", isCurrentUser: true },
            { id: "member-zoe", name: "Zoe", isCurrentUser: false },
          ],
        },
      ],
    });
    const form = createSessionHandoffForm(model);
    expect(form.destinationKey).toBe("");
    expect(sessionHandoffFormError(form, model)).toBe("project_required");

    expect(
      sessionHandoffFormForDestination(form, "project:project-beta", model)
    ).toMatchObject({
      destinationKey: "project:project-beta",
      assigneeMemberId: "member-me-beta",
    });
  });

  it("trims submission values and bounds the optional note", () => {
    const normalized = normalizedSessionHandoffForm({
      ...WORK_ITEM_PROPERTIES,
      title: "  Follow up  ",
      destinationKey: "project:project-alpha",
      assigneeMemberId: "member-lin",
      note: `  ${"x".repeat(1_100)}  `,
    });
    expect(normalized.title).toBe("Follow up");
    expect(normalized.note).toHaveLength(1_000);
  });

  it("projects the handoff form into the canonical Work Item property model", () => {
    const model = draft();
    const form = {
      ...createSessionHandoffForm(model),
      status: "in_review" as const,
      priority: "high" as const,
      targetDate: "2026-07-30T00:00:00.000Z",
    };

    expect(sessionHandoffFormToWorkItem(form, model)).toMatchObject({
      session_id: "session-1",
      user_id: "member-me",
      name: "Investigate sync",
      status: "in_review",
      workItemStatus: "in_review",
      priority: "high",
      target_date: "2026-07-30T00:00:00.000Z",
      endDate: "2026-07-30T00:00:00.000Z",
    });
  });

  it("applies shared property updates atomically without changing handoff fields", () => {
    const form = createSessionHandoffForm(draft());

    expect(
      sessionHandoffFormWithWorkItemUpdates(form, {
        workItemStatus: "in_progress",
        priority: "urgent",
        endDate: "2026-07-31T00:00:00.000Z",
        name: "must not replace the handoff title",
      })
    ).toEqual({
      ...form,
      status: "in_progress",
      priority: "urgent",
      targetDate: "2026-07-31T00:00:00.000Z",
    });
  });

  it("clears the handoff due date when the shared property control clears it", () => {
    const form = {
      ...createSessionHandoffForm(draft()),
      targetDate: "2026-07-31T00:00:00.000Z",
    };

    expect(
      sessionHandoffFormWithWorkItemUpdates(form, { endDate: undefined })
        .targetDate
    ).toBe("");
  });
});
