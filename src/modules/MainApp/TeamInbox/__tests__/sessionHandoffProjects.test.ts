import { describe, expect, it } from "vitest";

import type { MemberEntry, ProjectData } from "@src/api/http/project";

import {
  eligibleSessionHandoffProjects,
  handoffCloudOrgFromRoster,
  handoffProjectFromRoster,
  teamInboxViewerMemberIds,
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
      projectSlug: "alpha",
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

    expect(projects.map((candidate) => candidate.projectSlug)).toEqual([
      "alpha",
      "beta",
      "other-org",
    ]);
  });

  it("uses active cloud membership identities instead of local project aliases", () => {
    const resolved = handoffCloudOrgFromRoster(
      { orgId: "cloud-org-1", name: "Shared Org" },
      [
        {
          userId: "account-1106510024",
          displayName: "1106510024",
          status: "active",
        },
        {
          userId: "account-ahanafish",
          displayName: "ahanafish",
          status: "active",
        },
        {
          userId: "removed",
          displayName: "Former member",
          status: "removed",
        },
      ],
      "account-1106510024"
    );

    expect(resolved).toMatchObject({
      kind: "cloud_org",
      key: "cloud-org:cloud-org-1",
      sender: {
        id: "account-1106510024",
        name: "1106510024",
        isCurrentUser: true,
      },
      recipients: [
        {
          id: "account-1106510024",
          name: "1106510024",
          isCurrentUser: true,
        },
        {
          id: "account-ahanafish",
          name: "ahanafish",
          isCurrentUser: false,
        },
      ],
    });
  });

  it("queries assignments for the cloud account id and exact local aliases", () => {
    expect(
      teamInboxViewerMemberIds(
        new Set(["local-git-alias", "cloud-account-1"]),
        "cloud-account-1"
      )
    ).toEqual(["cloud-account-1", "local-git-alias"]);
  });
});
