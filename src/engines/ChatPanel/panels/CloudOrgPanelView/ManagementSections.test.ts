import type { TFunction } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CloudOrgMember } from "@src/features/Org2Cloud/org2CloudClient";
import type { CloudInviteRecord } from "@src/features/Org2Cloud/org2CloudOrgManagement";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import { CloudInvitesCard, CloudMembersSection } from "./ManagementSections";
import type { CloudOrgManagement } from "./useCloudOrgManagement";

const translations: Record<string, string> = {
  "cloud.orgPanel.aboutMeTitle": "About me",
  "cloud.orgPanel.membersTitle": "Members",
  "cloud.orgPanel.membersEmpty": "No members",
  "cloud.orgManagement.members.youTag": "You",
  "cloud.orgManagement.members.ownerTag": "Owner",
  "cloud.orgManagement.leave.action": "Leave org",
  "cloud.orgManagement.invites.createTitle": "New invite",
  "cloud.orgManagement.invites.historyTitle": "Previous invites",
  "cloud.orgManagement.invites.create": "Create invite",
  "cloud.orgManagement.invites.empty": "No invites yet",
  "cloud.orgManagement.invites.revoke": "Revoke",
  "cloud.orgManagement.invites.roleMember": "Member",
  "cloud.orgManagement.invites.stateRevoked": "Revoked",
  "cloud.orgManagement.invites.neverExpires": "Never expires",
  "cloud.orgManagement.invites.createdAt": "Created {{date}}",
  "cloud.orgManagement.invites.remainingUses": "Uses left: {{uses}}",
};

const t = ((key: string, options?: Record<string, unknown>) => {
  const template = translations[key] ?? key;
  if (!options) return template;
  return Object.entries(options).reduce(
    (text, [name, value]) => text.replace(`{{${name}}}`, String(value)),
    template
  );
}) as TFunction<"navigation">;

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

function invite(overrides: Partial<CloudInviteRecord> = {}): CloudInviteRecord {
  return {
    inviteId: "inv-1",
    role: "member",
    maxUses: 5,
    usedCount: 2,
    createdAt: "2026-07-28T15:16:00.000Z",
    ...overrides,
  };
}

function renderInvites(invites: CloudInviteRecord[]): string {
  return renderToStaticMarkup(
    createElement(CloudInvitesCard, {
      t,
      management: management({
        invites,
        inviteListError: null,
        creatingInvite: false,
        copyingInvite: false,
        inviteError: null,
        revokingInviteId: null,
        latestCreatedInvite: null,
        handleCreateInvite: vi.fn(),
        handleCopyInvite: vi.fn(),
        handleRevokeInvite: vi.fn(),
      }),
    })
  );
}

describe("CloudInvitesCard layout", () => {
  it("splits creation and history into two cards, create first", () => {
    const markup = renderInvites([invite()]);

    expect(markup.indexOf("New invite")).toBeLessThan(
      markup.indexOf("Previous invites")
    );
    // Create controls stay in the first card, the inventory in the second.
    expect(
      markup.indexOf('data-testid="cloud-org-create-invite"')
    ).toBeLessThan(markup.indexOf('data-testid="cloud-org-invite-history"'));
    expect(
      markup.indexOf('data-testid="cloud-org-invite-history"')
    ).toBeLessThan(markup.indexOf('data-testid="cloud-org-invite-row"'));
  });

  it("keeps an invite on one row with the status left of Revoke", () => {
    const markup = renderInvites([invite()]);
    const row = markup.slice(
      markup.indexOf('data-testid="cloud-org-invite-row"')
    );

    expect(row.indexOf("Uses left: 3")).toBeLessThan(
      row.indexOf('data-testid="cloud-org-invite-revoke-inv-1"')
    );
    // The status moved out of SectionRow's description slot (its only marker
    // class), so the row no longer stacks a second line under the label.
    expect(row).not.toContain("mt-0.5");
  });

  it("shows the empty state in the history card and no revoke for a revoked invite", () => {
    expect(renderInvites([])).toContain("No invites yet");

    const revoked = renderInvites([
      invite({ revokedAt: "2026-07-29T10:00:00.000Z" }),
    ]);
    expect(revoked).toContain("Revoked");
    expect(revoked).not.toContain(
      'data-testid="cloud-org-invite-revoke-inv-1"'
    );
  });
});

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

describe("CloudInvitesCard guide target", () => {
  it("anchors the invite spotlight to the create button only", () => {
    const markup = renderToStaticMarkup(
      createElement(CloudInvitesCard, {
        t,
        management: management({
          invites: [],
          inviteListError: null,
          creatingInvite: false,
          copyingInvite: false,
          inviteError: null,
          revokingInviteId: null,
          latestCreatedInvite: null,
          handleCreateInvite: vi.fn(),
          handleCopyInvite: vi.fn(),
          handleRevokeInvite: vi.fn(),
        }),
      })
    );

    const createButton = markup.match(
      /<button[^>]*data-testid="cloud-org-create-invite"[^>]*>/
    )?.[0];

    expect(createButton).toBeDefined();
    expect(createButton).toContain(
      `data-guide-target="${GUIDE_TARGETS.CLOUD_ORG_INVITE_ACTION}"`
    );
    expect(markup).not.toMatch(
      /<div[^>]*data-guide-target="cloudOrg\.inviteAction"/
    );
  });
});
