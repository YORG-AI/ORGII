/** @vitest-environment jsdom */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCloudRemoteItemId } from "@src/features/Org2Cloud/cloudRemoteItemId";
import { org2CloudAuthAtom } from "@src/features/Org2Cloud/org2CloudAuthAtom";
import { org2CloudOrgsAtom } from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { org2CloudPresenceAtom } from "@src/features/Org2Cloud/org2CloudPresenceAtom";
import {
  CLOUD_MY_SESSIONS_SECTION_ID,
  CLOUD_TEAM_SESSIONS_SECTION_ID,
} from "@src/scaffold/NavigationSidebar/connectors/WorkstationSidebarConnector/cloudScopedMenuItems";
import { createSmokeRoot, dispatch } from "@src/test/reactSmokeHarness";

import { WebSessionSidebar } from "./WebSessionSidebar";

const testState = vi.hoisted(() => ({
  location: {
    pathname: "/sessions/org-1/session-1",
    search: "",
  },
  navigate: vi.fn(),
  refresh: vi.fn(),
  setAuth: vi.fn(),
  sidebarProps: null as Record<string, unknown> | null,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, defaultValue?: string) => defaultValue ?? key,
  }),
}));

vi.mock("jotai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jotai")>();
  return {
    ...actual,
    useAtom: () => [
      { profile: { displayName: "Web User" }, userId: "user-1" },
      testState.setAuth,
    ],
    useAtomValue: (atom: unknown) => {
      if (atom === org2CloudOrgsAtom) {
        return [
          { orgId: "org-1", name: "Organization One" },
          { orgId: "org-2", name: "Organization Two" },
        ];
      }
      if (atom === org2CloudAuthAtom) {
        return {
          userId: "user-1",
          profile: { displayName: "Web User" },
        };
      }
      if (atom === org2CloudPresenceAtom) {
        return {};
      }
      return undefined;
    },
  };
});

vi.mock("react-router-dom", () => ({
  useLocation: () => testState.location,
  useNavigate: () => testState.navigate,
}));

vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    icon,
    loading: _loading,
    iconOnly: _iconOnly,
    appearance: _appearance,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<"button"> & {
    icon?: React.ReactNode;
    loading?: boolean;
    iconOnly?: boolean;
    appearance?: string;
    variant?: string;
    size?: string;
  }) => React.createElement("button", props, icon, children),
}));

vi.mock("@src/scaffold/NavigationSidebar", () => ({
  NavigationSidebar: (props: Record<string, unknown>) => {
    testState.sidebarProps = props;
    return React.createElement(
      "aside",
      { "data-web-sidebar": true },
      props.preListContent as React.ReactNode,
      props.bottomContent as React.ReactNode
    );
  },
  SidebarOrgSelector: ({
    value,
    onChange,
    cloudSignedInIdentity,
  }: {
    value: string;
    onChange: (value: string) => void;
    cloudSignedInIdentity?: string | null;
  }) =>
    React.createElement(
      "button",
      {
        "data-org-selector": value,
        "data-cloud-identity": cloudSignedInIdentity ?? "",
        onClick: () => onChange("org-2"),
      },
      value
    ),
  SidebarBottomBar: ({
    leftContent,
    rightActions,
  }: {
    leftContent: React.ReactNode;
    rightActions: React.ReactNode;
  }) => React.createElement("footer", null, leftContent, rightActions),
  SidebarMenuSearchInput: ({ placeholder }: { placeholder: string }) =>
    React.createElement("input", { placeholder }),
}));

vi.mock("../features/sessions/WebSessionsContext", () => ({
  useWebSessions: () => ({
    status: "loaded",
    error: null,
    refresh: testState.refresh,
    sessions: [
      {
        id: "session-1",
        orgId: "org-1",
        orgName: "Organization One",
        sourceSessionId: "local-1",
        title: "First session",
        agentDisplayName: "Codex",
        cliAgentType: "codex",
        lastActivityAt: "2026-08-19T12:00:00.000Z",
        status: "stopped",
        eventsEpoch: 1,
        ownerUserId: "user-1",
        ownerDisplayName: "Web User",
      },
      {
        id: "session-2",
        orgId: "org-2",
        orgName: "Organization Two",
        sourceSessionId: "local-2",
        title: "Second session",
        agentDisplayName: "Claude",
        cliAgentType: "claude",
        lastActivityAt: "2026-08-19T13:00:00.000Z",
        status: "running",
        eventsEpoch: 1,
        ownerUserId: "user-2",
        ownerDisplayName: "Teammate",
      },
    ],
  }),
}));

describe("WebSessionSidebar", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
    testState.location = {
      pathname: "/sessions/org-1/session-1",
      search: "",
    };
    testState.navigate.mockReset();
    testState.refresh.mockReset();
    testState.setAuth.mockReset();
    testState.sidebarProps = null;
  });

  it("reuses desktop sidebar chrome and cloud session menu ids", async () => {
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(React.createElement(WebSessionSidebar));

    expect(testState.sidebarProps?.includeTrafficLightSpace).toBe(false);
    expect(testState.sidebarProps?.showCollapseButton).toBe(false);
    expect(
      root.container
        .querySelector("[data-org-selector]")
        ?.getAttribute("data-org-selector")
    ).toBe("org-1");
    expect(
      root.container
        .querySelector("[data-cloud-identity]")
        ?.getAttribute("data-cloud-identity")
    ).toBe("Web User");
    expect(
      root.container.querySelector('input[placeholder="Search..."]')
    ).not.toBeNull();

    const menuItems = testState.sidebarProps?.menuItems as Array<{
      id: string;
    }>;
    expect(menuItems[0]?.id).toBe(
      `separator-${CLOUD_TEAM_SESSIONS_SECTION_ID}`
    );
    expect(
      menuItems.some(
        (item) => item.id === buildCloudRemoteItemId("org-1", "session-1")
      )
    ).toBe(true);
    expect(
      menuItems.some(
        (item) => item.id === `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`
      )
    ).toBe(true);
    expect(testState.sidebarProps?.selectedKey).toBe(
      buildCloudRemoteItemId("org-1", "session-1")
    );

    await dispatch(() =>
      root.container
        .querySelector<HTMLButtonElement>("[data-org-selector]")
        ?.click()
    );
    expect(testState.navigate).toHaveBeenCalledWith("/sessions?org=org-2");
  });

  it("uses the URL organization scope on the sessions landing page", async () => {
    testState.location = {
      pathname: "/sessions",
      search: "?org=org-2",
    };
    const root = createSmokeRoot();
    roots.push(root);
    await root.render(React.createElement(WebSessionSidebar));

    expect(
      root.container
        .querySelector("[data-org-selector]")
        ?.getAttribute("data-org-selector")
    ).toBe("org-2");
    const menuItems = testState.sidebarProps?.menuItems as Array<{
      id: string;
    }>;
    expect(
      menuItems.some(
        (item) => item.id === buildCloudRemoteItemId("org-2", "session-2")
      )
    ).toBe(true);
    expect(
      menuItems.some(
        (item) => item.id === `separator-${CLOUD_MY_SESSIONS_SECTION_ID}`
      )
    ).toBe(true);
  });
});
