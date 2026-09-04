// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { GUIDE_TARGETS } from "@src/scaffold/Tutorials/guideTargets";

import { CloudOrgPanelView } from "./index";

vi.mock("@src/features/Org2Cloud/org2CloudOrgsAtom", async () => {
  const { atom } = await import("jotai");
  return {
    buildCloudOrgSelectorValue: (orgId: string) => `cloud:${orgId}`,
    org2CloudOrgsAtom: atom<
      Array<{ orgId: string; name: string; role: string }>
    >([]),
    useRefetchOrg2CloudOrgs: () => vi.fn(),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/features/Org2Cloud/useOpenCloudBilling", () => ({
  useOpenCloudBilling: () => vi.fn(),
}));

vi.mock("./useOrgBackgroundUpload", () => ({
  useOrgBackgroundUpload: () => ({}),
}));

vi.mock("./useOrgRuntimeTelemetry", () => ({
  useOrgRuntimeTelemetry: () => ({}),
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  DETAIL_PANEL_TOKENS: {
    scrollContentNoTop: "",
    contentWidthWithPaddingNoTop: "",
  },
  ScrollFadeContainer: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock("./CloudOrgPanelHeader", () => ({
  default: ({ activeTab }: { activeTab: string }) => `active:${activeTab}`,
}));

vi.mock("./CloudOrgRepoScopesSection", () => ({
  default: () => "repo-scopes",
}));

vi.mock("./CloudOrgSettingsSection", () => ({
  default: () => "general-settings",
}));

vi.mock("./ManagementSections", () => ({
  CloudInvitesCard: () => "invite-controls:enabled",
  CloudMembersSection: ({
    members,
  }: {
    members: Array<{ userId: string; role: string }>;
  }) => `member-controls:enabled:${members[0]?.role}`,
}));

vi.mock("./useCloudOrgManagement", () => ({
  useCloudOrgManagement: () => ({}),
}));

vi.mock("./useCloudOrgPanelState", () => ({
  useCloudOrgPanelState: () => ({
    viewState: "ready",
    members: [
      {
        userId: "admin-a",
        displayName: "Admin",
        role: "admin",
        status: "active",
      },
    ],
    setMembers: vi.fn(),
    currentUserId: "admin-a",
  }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("CloudOrgPanelView guide navigation", () => {
  let container: HTMLDivElement;
  let root: Root;
  const store = createStore();

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "org-a", name: "ORG A", role: "admin" },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("honors repeated explicit tab requests on an already-open org", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(CloudOrgPanelView, {
            selectedCloudOrg: {
              orgId: "org-a",
              initialView: "members",
              initialViewRequestId: 1,
            },
          })
        )
      );
    });

    expect(container.textContent).toContain("active:members");
    expect(container.textContent).toContain("invite-controls");
    expect(container.textContent).not.toContain("general-settings");

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(CloudOrgPanelView, {
            selectedCloudOrg: {
              orgId: "org-a",
              initialView: "general",
              initialViewRequestId: 2,
            },
          })
        )
      );
    });

    expect(container.textContent).toContain("active:general");
    expect(container.textContent).toContain("general-settings");
    expect(container.textContent).not.toContain("invite-controls");
  });

  it("renders a stable members spotlight target without invite controls for a member", async () => {
    store.set(org2CloudOrgsAtom, [
      { orgId: "org-a", name: "ORG A", role: "member" },
    ]);

    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(CloudOrgPanelView, {
            selectedCloudOrg: {
              orgId: "org-a",
              initialView: "members",
              initialViewRequestId: 3,
            },
          })
        )
      );
    });

    expect(container.textContent).toContain("active:members");
    expect(container.textContent).toContain("member-controls");
    expect(container.textContent).not.toContain("invite-controls");
    expect(
      container.querySelector(
        `[data-guide-target="${GUIDE_TARGETS.CLOUD_ORG_MEMBERS_SECTION}"]`
      )
    ).not.toBeNull();
  });
});
