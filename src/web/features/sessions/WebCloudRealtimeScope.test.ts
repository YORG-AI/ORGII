/** @vitest-environment jsdom */
import { Provider, createStore } from "jotai";
import React from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  org2CloudOrgsAtom,
  sidebarActiveCloudOrgIdAtom,
} from "@src/features/Org2Cloud/org2CloudOrgsAtom";
import { createSmokeRoot } from "@src/test/reactSmokeHarness";

import {
  WebCloudRealtimeScope,
  resolveWebActiveCloudOrgId,
} from "./WebCloudRealtimeScope";

const mocks = vi.hoisted(() => ({
  useRealtime: vi.fn(),
}));

vi.mock("@src/features/Org2Cloud/useOrg2CloudRealtime", () => ({
  useOrg2CloudRealtime: () => mocks.useRealtime(),
}));

describe("resolveWebActiveCloudOrgId", () => {
  const availableOrgIds = ["org-1", "org two"];

  it("prefers a valid session route over query and fallback scopes", () => {
    expect(
      resolveWebActiveCloudOrgId({
        pathname: "/sessions/org%20two/session-1/replay",
        search: "?org=org-1",
        availableOrgIds,
      })
    ).toBe("org two");
  });

  it("uses a valid query scope, then the first available organization", () => {
    expect(
      resolveWebActiveCloudOrgId({
        pathname: "/sessions",
        search: "?org=org%20two",
        availableOrgIds,
      })
    ).toBe("org two");
    expect(
      resolveWebActiveCloudOrgId({
        pathname: "/sessions/missing/session-1",
        search: "?org=missing",
        availableOrgIds,
      })
    ).toBe("org-1");
  });
});

describe("WebCloudRealtimeScope", () => {
  const roots: Array<ReturnType<typeof createSmokeRoot>> = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => root.unmount()));
    mocks.useRealtime.mockReset();
  });

  it("projects the route org for Realtime and clears it on teardown", async () => {
    const store = createStore();
    store.set(org2CloudOrgsAtom, [
      { orgId: "org-1", name: "One", role: "member" },
      { orgId: "org-2", name: "Two", role: "member" },
    ]);
    const root = createSmokeRoot();
    roots.push(root);

    await root.render(
      React.createElement(
        Provider,
        { store },
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/sessions/org-2/session-1"] },
          React.createElement(WebCloudRealtimeScope)
        )
      )
    );

    expect(store.get(sidebarActiveCloudOrgIdAtom)).toBe("org-2");
    expect(mocks.useRealtime).toHaveBeenCalled();

    await root.unmount();
    roots.splice(roots.indexOf(root), 1);
    expect(store.get(sidebarActiveCloudOrgIdAtom)).toBeNull();
  });
});
