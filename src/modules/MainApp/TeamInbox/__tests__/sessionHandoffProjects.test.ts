import { describe, expect, it } from "vitest";

import type { MemberEntry, ProjectData } from "@src/api/http/project";

import {
  eligibleSessionHandoffProjects,
  handoffProjectFromRoster,
} from "../sessionHandoffProjects";

function project(slug: string, name: string, orgId = "org-1"): ProjectData {
  return {
    slug,
    description: "",
    meta: {
      id: `id-${slug}`,
      name,
      org_id: orgId,
      status: "active",
      priority: "none",
      health: "no_updates",
      members: [],
      labels: [],
      linked_repos: [],
      created_at: "2026-07-28T00:00:00Z",
      updated_at: "2026-07-28T00:00:00Z",
      next_work_item_id: 1,
      work_item_prefix: "TST",
      work_item_prefix_custom: false,
    },
  };
}

function member(id: string, name: string, active = true): MemberEntry {
  return { id, name, active };
}

describe("Session handoff project resolution", () => {
  it("uses the matching project-local alias as sender", () => {
    const resolved = handoffProjectFromRoster(
      project("alpha", "Alpha"),
      [
        member("me-work", "Me"),
        member("teammate", "Lin"),
        member("inactive", "Former teammate", false),
      ],
      ["me-personal", "me-work"]
    );

    expect(resolved).toMatchObject({
      slug: "alpha",
      sender: { id: "me-work", isCurrentUser: true },
      recipients: [
        { id: "me-work", isCurrentUser: true },
        { id: "teammate", isCurrentUser: false },
      ],
    });
  });

  it("keeps every project where the viewer is a member across sidebar scopes", () => {
    const projects = eligibleSessionHandoffProjects(
      [
        {
          project: project("beta", "Beta", "org-1"),
          members: [member("me", "Me")],
        },
        {
          project: project("alpha", "Alpha", "org-1"),
          members: [member("me", "Me"), member("lin", "Lin")],
        },
        {
          project: project("other-org", "Other", "org-2"),
          members: [member("me", "Me")],
        },
        {
          project: project("not-a-member", "Hidden", "org-1"),
          members: [member("lin", "Lin")],
        },
      ],
      ["me"]
    );

    expect(projects.map((candidate) => candidate.slug)).toEqual([
      "alpha",
      "beta",
      "other-org",
    ]);
  });
});
