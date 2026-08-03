// @vitest-environment jsdom
import type { TFunction } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { CloudOrgMember } from "@src/features/Org2Cloud/org2CloudClient";
import { COLLAB_SESSION_ACCESS_MODE } from "@src/store/collaboration/types";

import { CloudOrgSettingsSection } from "./CloudOrgSettingsSection";
import type { CloudOrgManagement } from "./useCloudOrgManagement";
import type { OrgBackgroundUploadState } from "./useOrgBackgroundUpload";
import type { OrgRuntimeTelemetryState } from "./useOrgRuntimeTelemetry";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      key === "actions.open"
        ? "Open"
        : vars
          ? `${key}:${Object.values(vars).join(",")}`
          : key,
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
  "cloud.backgroundUpload.label": "Background upload",
  "cloud.backgroundUpload.help": "Upload while inactive",
  "cloud.backgroundUpload.on": "On",
  "cloud.backgroundUpload.off": "Off",
  "cloud.backgroundUpload.memberNote": "Uploads without opening this org",
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

function runtimeSharing(
  overrides: Partial<OrgRuntimeTelemetryState> = {}
): OrgRuntimeTelemetryState {
  return {
    value: "off",
    saving: false,
    error: null,
    handleChange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function backgroundUpload(
  overrides: Partial<OrgBackgroundUploadState> = {}
): OrgBackgroundUploadState {
  return {
    value: "off",
    enabled: false,
    saving: false,
    error: null,
    handleChange: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function renderSettings(
  overrides: Partial<CloudOrgManagement> = {},
  runtimeSharingOverrides: Partial<OrgRuntimeTelemetryState> = {},
  backgroundUploadOverrides: Partial<OrgBackgroundUploadState> = {}
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
      runtimeSharing: runtimeSharing(runtimeSharingOverrides),
      backgroundUpload: backgroundUpload(backgroundUploadOverrides),
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

  it("gives admins a runtime-sharing select beside the sharing floor", () => {
    const root = renderSettings({}, { value: "60" });

    const row = root
      .querySelector('[data-testid="cloud-org-runtime-telemetry"]')
      ?.closest(".section-layout-row");
    const floorRow = root
      .querySelector('[data-testid="cloud-org-sharing-floor"]')
      ?.closest(".section-layout-row");
    expect(row).not.toBeNull();
    expect(row?.parentElement).toBe(floorRow?.parentElement);
    expect(
      root.querySelector('[data-testid="cloud-org-runtime-telemetry-select"]')
    ).not.toBeNull();
    // The hook clamps/snap-displays the stored interval; the row renders it.
    expect(
      root.querySelector('[data-testid="cloud-org-runtime-telemetry"]')
        ?.textContent
    ).toContain("orgSettings.interval.60");
    expect(
      root.querySelector(
        '[data-testid="cloud-org-runtime-telemetry-member-note"]'
      )
    ).toBeNull();
  });

  it("shows the background-upload policy as an admin control or member note", () => {
    const admin = renderSettings();
    expect(
      admin.querySelector('[data-testid="cloud-org-background-upload-select"]')
    ).not.toBeNull();
    expect(admin.textContent).toContain("Background upload");

    const memberEnabled = renderSettings(
      { isAdmin: false },
      {},
      { value: "on", enabled: true }
    );
    expect(
      memberEnabled.querySelector(
        '[data-testid="cloud-org-background-upload-member-note"]'
      )
    ).not.toBeNull();
    expect(
      memberEnabled.querySelector(
        '[data-testid="cloud-org-background-upload-select"]'
      )
    ).toBeNull();

    const memberOff = renderSettings({ isAdmin: false });
    expect(
      memberOff.querySelector(
        '[data-testid="cloud-org-background-upload-member-note"]'
      )
    ).toBeNull();
  });

  it("shows members a read-only runtime-sharing note only while enabled", () => {
    const enabled = renderSettings({ isAdmin: false }, { value: "180" });
    const note = enabled.querySelector(
      '[data-testid="cloud-org-runtime-telemetry-member-note"]'
    );
    expect(note).not.toBeNull();
    expect(note?.closest(".section-layout-row")?.textContent).toContain(
      "orgSettings.memberNote:orgSettings.interval.180"
    );
    expect(
      enabled.querySelector(
        '[data-testid="cloud-org-runtime-telemetry-select"]'
      )
    ).toBeNull();

    const off = renderSettings({ isAdmin: false }, { value: "off" });
    expect(
      off.querySelector(
        '[data-testid="cloud-org-runtime-telemetry-member-note"]'
      )
    ).toBeNull();
  });
});
