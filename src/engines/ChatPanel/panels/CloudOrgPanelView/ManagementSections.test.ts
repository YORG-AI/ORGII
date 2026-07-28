import type { TFunction } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CloudOrgMember } from "@src/features/Org2Cloud/org2CloudClient";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import { CloudMembersSection } from "./ManagementSections";
import type { CloudOrgManagement } from "./useCloudOrgManagement";

const translations: Record<string, string> = {
  "cloud.orgPanel.aboutMeTitle": "About me",
  "cloud.orgPanel.membersTitle": "Members",
  "cloud.orgPanel.membersEmpty": "No members",
  "cloud.orgManagement.members.youTag": "You",
  "cloud.orgManagement.members.ownerTag": "Owner",
  "cloud.orgManagement.leave.action": "Leave org",
};

const t = ((key: string) =>
  translations[key] ?? key) as TFunction<"navigation">;

function member(
  userId: string,
  displayName: string,
  role: CloudOrgMember["role"] = "member"
): CloudOrgMember {
  return {
    userId,
    displayName,
    role,
    status: "active",
  };
}

function management(
  overrides: Partial<CloudOrgManagement> = {}
): CloudOrgManagement {
  return {
    isAdmin: false,
    isOwner: false,
    memberError: null,
    removingUserId: null,
    updatingRoleUserId: null,
    updatingFloorUserId: null,
    leavingOrg: false,
    leaveError: null,
    handleUpdateMemberRole: vi.fn(),
    handleUpdateMemberFloor: vi.fn(),
    handleRemoveMember: vi.fn(),
    handleLeaveOrg: vi.fn(),
    ...overrides,
  } as unknown as CloudOrgManagement;
}

function renderMembers(
  members: CloudOrgMember[],
  currentUserId: string,
  overrides: Partial<CloudOrgManagement> = {}
): string {
  return renderToStaticMarkup(
    createElement(CloudMembersSection, {
      t,
      members,
      currentUserId,
      management: management(overrides),
      orgFloor: COLLAB_SESSION_ACCESS_MODE.OFF,
    })
  );
}

describe("CloudMembersSection layout", () => {
  it("shows the signed-in user in About me above the remaining members", () => {
    const markup = renderMembers(
      [member("self", "Current user", "admin"), member("other", "Teammate")],
      "self"
    );

    expect(markup.indexOf("About me")).toBeLessThan(markup.indexOf("Members"));
    expect(markup).toContain('data-testid="cloud-org-about-me"');
    expect(markup).not.toContain('data-member-id="self"');
    expect(markup).toContain('data-member-id="other"');
  });

  it("renders Leave org as an outlined secondary-style danger action", () => {
    const markup = renderMembers([member("self", "Current user")], "self");
    const leaveButton = markup.match(
      /<button[^>]*data-testid="cloud-org-leave"[^>]*>/
    )?.[0];

    expect(leaveButton).toContain("border-border-2");
    expect(leaveButton).toContain("text-danger-6");
    expect(markup).toContain("No members");
  });

  it("does not offer Leave org to the owner", () => {
    const markup = renderMembers(
      [member("self", "Current owner", "owner")],
      "self",
      {
        isAdmin: true,
        isOwner: true,
      }
    );

    expect(markup).toContain('data-testid="cloud-org-about-me"');
    expect(markup).not.toContain('data-testid="cloud-org-leave"');
  });

  it("shows disabled management controls for another owner", () => {
    const markup = renderMembers(
      [
        member("self", "Current admin", "admin"),
        member("owner", "Org owner", "owner"),
      ],
      "self",
      { isAdmin: true }
    );
    const floorSelect = markup.match(
      /<div[^>]*data-testid="cloud-org-member-floor-owner"[^>]*>/
    )?.[0];
    const roleSelect = markup.match(
      /<div[^>]*data-testid="cloud-org-member-role-owner"[^>]*>/
    )?.[0];
    const removeButton = markup.match(
      /<button[^>]*data-testid="cloud-org-member-remove-owner"[^>]*>/
    )?.[0];

    expect(floorSelect).toContain("select-disabled");
    expect(floorSelect).toContain('tabindex="-1"');
    expect(roleSelect).toContain("select-disabled");
    expect(roleSelect).toContain('tabindex="-1"');
    expect(removeButton).toContain("disabled");
  });
});
