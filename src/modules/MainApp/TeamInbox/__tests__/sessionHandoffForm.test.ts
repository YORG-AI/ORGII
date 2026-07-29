import { describe, expect, it } from "vitest";

import type { TeamInboxSessionHandoffDraft } from "../domain";
import {
  createSessionHandoffForm,
  isTeamHandoff,
  normalizedSessionHandoffForm,
  sessionHandoffFormError,
  sessionHandoffFormForProject,
} from "../sessionHandoffForm";

function draft(
  overrides: Partial<TeamInboxSessionHandoffDraft> = {}
): TeamInboxSessionHandoffDraft {
  return {
    sessionId: "session-1",
    title: "Investigate sync",
    sourceProjectSlug: "project-alpha",
    projects: [
      {
        id: "project-1",
        slug: "project-alpha",
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

describe("sessionHandoffForm", () => {
  it("defaults to the current user to prevent accidental handoff", () => {
    expect(createSessionHandoffForm(draft())).toEqual({
      title: "Investigate sync",
      projectSlug: "project-alpha",
      assigneeMemberId: "member-me",
      note: "",
    });
  });

  it("distinguishes self creation from a team handoff", () => {
    const model = draft();
    expect(isTeamHandoff(createSessionHandoffForm(model), model)).toBe(false);
    expect(
      isTeamHandoff(
        {
          title: model.title,
          projectSlug: "project-alpha",
          assigneeMemberId: "member-lin",
          note: "",
        },
        model
      )
    ).toBe(true);
  });

  it("treats another current-user alias as self assignment", () => {
    const model = draft({
      projects: [
        {
          id: "project-1",
          slug: "project-alpha",
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
          title: model.title,
          projectSlug: "project-alpha",
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
          title: " ",
          projectSlug: "project-alpha",
          assigneeMemberId: "member-me",
          note: "",
        },
        model
      )
    ).toBe("title_required");
    expect(
      sessionHandoffFormError(
        {
          title: "Valid",
          projectSlug: "project-alpha",
          assigneeMemberId: "removed",
          note: "",
        },
        model
      )
    ).toBe("recipient_unavailable");
  });

  it("requires an explicit destination when an unscoped Session has multiple projects", () => {
    const model = draft({
      sourceProjectSlug: undefined,
      projects: [
        ...draft().projects,
        {
          id: "project-2",
          slug: "project-beta",
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
    expect(form.projectSlug).toBe("");
    expect(sessionHandoffFormError(form, model)).toBe("project_required");

    expect(
      sessionHandoffFormForProject(form, "project-beta", model)
    ).toMatchObject({
      projectSlug: "project-beta",
      assigneeMemberId: "member-me-beta",
    });
  });

  it("trims submission values and bounds the optional note", () => {
    const normalized = normalizedSessionHandoffForm({
      title: "  Follow up  ",
      projectSlug: "project-alpha",
      assigneeMemberId: "member-lin",
      note: `  ${"x".repeat(1_100)}  `,
    });
    expect(normalized.title).toBe("Follow up");
    expect(normalized.note).toHaveLength(1_000);
  });
});
