// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter, useRoutes } from "react-router-dom";
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

import { appStandaloneRouteGroup } from "./routeGroups";

vi.mock("@src/config/serviceAuth", () => ({
  HOSTED_LOGIN_ENABLED: false,
}));

vi.mock("@src/router/lazy/pages", () => {
  const Placeholder = () => null;

  return {
    AgentStudioPage: Placeholder,
    AuthCallback: Placeholder,
    ConsumerWallet: Placeholder,
    DelegationHistoryPage: Placeholder,
    FlowAwarenessTestPage: Placeholder,
    LoginPage: Placeholder,
    Profile: Placeholder,
    ProviderBoost: Placeholder,
    ProviderEarnings: Placeholder,
    PublicProfilePage: Placeholder,
    SelectRepoPage: Placeholder,
    SessionWindowPage: Placeholder,
  };
});

vi.mock("@src/modules/shared/layouts/MainAppShell", () => ({
  default: () => null,
}));

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const RouteHarness = () =>
  useRoutes([
    {
      path: "/orgii",
      children: appStandaloneRouteGroup,
    },
    {
      path: "/orgii/workstation",
      element: React.createElement(
        "div",
        { "data-testid": "workstation-route" },
        "Workstation"
      ),
    },
  ]);

describe("standalone app routes", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
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

  const renderRoute = async (path: string) => {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: [path] },
          React.createElement(RouteHarness)
        )
      );
    });
  };

  it("does not register the retired setup walkthrough URL", () => {
    expect(
      appStandaloneRouteGroup.some((route) => route.path === "app/walkthrough")
    ).toBe(false);
  });

  it("keeps the login page behind the hosted-login guard", async () => {
    await renderRoute("/orgii/app/login");

    expect(
      container.querySelector('[data-testid="workstation-route"]')
    ).not.toBeNull();
  });
});
