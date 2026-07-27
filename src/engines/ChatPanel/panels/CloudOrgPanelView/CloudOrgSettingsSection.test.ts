// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CloudOrgMember } from "@src/features/Org2Cloud/org2CloudClient";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import { CloudOrgSettingsSection } from "./CloudOrgSettingsSection";
import type { CloudOrgManagement } from "./useCloudOrgManagement";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "actions.open" ? "Open" : key),
  }),
}));

const translations: Record<string, string> = {
  "routes.sessions": "Sessions",
  "cloud.orgManagement.settings.title": "Org settings",
  "cloud.orgManagement.settings.renameLabel": "Org name",
  "cloud.orgManagement.settings.renameSave": "Rename",
  "cloud.orgPanel.planStatus": "Team · active",
  "cloud.orgPanel.manageBillingNote": "Manage billing",
  "cloud.orgPanel.manageBilling": "Manage billing",
  "cloud.orgPanel.retention": "Replay retention",
  "cloud.orgPanel.retentionNote": "Retention note",
  "cloud.sharingFloor.label": "Minimum sharing level",
  "cloud.sharingFloor.help": "Minimum sharing help",
  "cloud.sharingFloor.optionNone": "No minimum",
  "cloud.sharingFloor.memberNote": "Minimum sharing applies",
  "cloud.syncLevel.modeMetadata": "Metadata",
  "cloud.syncLevel.modeFullReplay": "Full replay",
};

const t = ((key: string) =>
  translations[key] ?? key) as TFunction<"navigation">;

const members: CloudOrgMember[] = [
  {
    userId: "admin",
    displayName: "Admin",
    role: "admin",
    status: "active",
  },
];

function management(
  overrides: Partial<CloudOrgManagement> = {}
): CloudOrgManagement {
  return {
    isAdmin: true,
    isOwner: false,
    renaming: false,
    renameSaved: false,
    renameError: null,
    transferring: false,
    transferError: null,
    deleting: false,
    deleteError: null,
    handleRenameOrg: vi.fn(),
    handleTransferOwnership: vi.fn(),
    handleDeleteOrg: vi.fn(),
    ...overrides,
  } as unknown as CloudOrgManagement;
}

function renderSettings(
  overrides: Partial<CloudOrgManagement> = {}
): DocumentFragment {
  const markup = renderToStaticMarkup(
    createElement(CloudOrgSettingsSection, {
      t,
      entitlement: {
        plan: "team",
        status: "active",
        replayRetentionDays: 30,
      },
      orgFloor: COLLAB_SESSION_ACCESS_MODE.METADATA_ONLY,
      savingFloor: false,
      floorError: null,
      onFloorChange: vi.fn().mockResolvedValue(undefined),
      openCloudBillingPage: vi.fn(),
      orgName: "Example team",
      members,
      currentUserId: "admin",
      management: management(overrides),
      onOpenSessions: vi.fn(),
    })
  );
  const template = document.createElement("template");
  template.innerHTML = markup;
  return template.content;
}

describe("CloudOrgSettingsSection layout", () => {
  it("puts Sessions, plan, minimum sharing, and org name in one settings card", () => {
    const root = renderSettings();
    const planRow = root.querySelector(
      '[data-testid="cloud-org-plan-section"]'
    );
    const floorRow = root
      .querySelector('[data-testid="cloud-org-sharing-floor"]')
      ?.closest(".section-layout-row");
    const nameRow = root.querySelector('[data-testid="cloud-org-settings"]');
    const sessionsRow = root.querySelector(
      '[data-testid="cloud-org-sessions-row"]'
    );

    expect(planRow).not.toBeNull();
    expect(floorRow).not.toBeNull();
    expect(nameRow).not.toBeNull();
    expect(sessionsRow).not.toBeNull();
    expect(
      sessionsRow?.querySelector('[data-testid="cloud-org-open-sessions"]')
        ?.textContent
    ).toBe("Open");
    expect(planRow?.parentElement).toBe(sessionsRow?.parentElement);
    expect(planRow?.parentElement).toBe(floorRow?.parentElement);
    expect(planRow?.parentElement).toBe(nameRow?.parentElement);
    expect(planRow?.parentElement?.classList).toContain("@container");
    const rows = Array.from(planRow?.parentElement?.children ?? []);
    expect(rows.indexOf(planRow as Element)).toBeLessThan(
      rows.indexOf(sessionsRow as Element)
    );
    expect(rows.indexOf(sessionsRow as Element)).toBeLessThan(
      rows.indexOf(floorRow as Element)
    );
    expect(rows.indexOf(floorRow as Element)).toBeLessThan(
      rows.indexOf(nameRow as Element)
    );
    expect(planRow?.classList).toContain("@[480px]:items-start");
    expect(floorRow?.classList).toContain("@[480px]:items-start");
    expect(nameRow?.classList).toContain("@[480px]:items-center");
    expect(floorRow?.classList).toContain("section-layout-row");
    expect(nameRow?.classList).toContain("section-layout-row");
  });

  it("keeps the shared plan and member floor note without admin controls", () => {
    const root = renderSettings({ isAdmin: false });

    expect(
      root.querySelector('[data-testid="cloud-org-plan-section"]')
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sharing-floor-member-note"]')
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sessions-row"]')
    ).not.toBeNull();
    expect(
      root.querySelector('[data-testid="cloud-org-sharing-floor"]')
    ).toBeNull();
    expect(root.querySelector('[data-testid="cloud-org-settings"]')).toBeNull();
  });
});
