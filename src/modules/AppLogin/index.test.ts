// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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

import { consumeOpaquePairingIntent } from "@src/modules/MobileRemote/auth/mobileAuthIntent";

import LoginPage from ".";

const mocks = vi.hoisted(() => ({
  login: vi.fn(() => Promise.resolve()),
  setAuthSkipped: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  Trans: () => null,
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@src/components/Button", () => ({
  default: ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
  }) => React.createElement("button", { onClick }, children),
}));

vi.mock("@src/components/InlineAlert", () => ({
  default: () => null,
}));

vi.mock("@src/config/serviceAuth", () => ({
  HOSTED_LOGIN_ENABLED: true,
  setAuthSkipped: mocks.setAuthSkipped,
}));

vi.mock("@src/hooks/auth/useServiceAuth", () => ({
  clearAuthStateCompletely: vi.fn(),
  useServiceAuth: () => ({
    isAuthenticated: false,
    isLoading: false,
    login: mocks.login,
  }),
}));

vi.mock("@src/modules/shared/layouts", () => ({
  ONBOARDING_LOADING_VIDEO_WIDTH_CLASS: "test-width",
  OnboardingLayout: ({ leftContent }: { leftContent?: React.ReactNode }) =>
    React.createElement("main", null, leftContent),
  OnboardingLoadingVideo: () => null,
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const CurrentLocationProbe = () => {
  const location = useLocation();
  return React.createElement("output", {
    "data-location": `${location.pathname}${location.search}${location.hash}`,
  });
};

describe("LoginPage return target", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  const renderLogin = async (
    from = {
      pathname: "/orgii/mobile",
      search: "?relay=wss%3A%2F%2Frelay.example",
      hash: "#pair=device-intent",
    }
  ) => {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          {
            initialEntries: [
              {
                pathname: "/orgii/app/login",
                state: {
                  from,
                },
              },
            ],
          },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: "/orgii/app/login",
              element: React.createElement(LoginPage),
            }),
            React.createElement(Route, {
              path: "/orgii/mobile",
              element: React.createElement(CurrentLocationProbe),
            })
          )
        )
      );
    });
  };

  it("stores a sanitized mobile return path and keeps pairing in its dedicated intent", async () => {
    await renderLogin();

    const loginButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "login.button"
    );
    expect(loginButton).toBeDefined();
    await act(async () => {
      loginButton?.click();
    });

    expect(sessionStorage.getItem("login_redirect")).toBe(
      "/orgii/mobile?relay=wss%3A%2F%2Frelay.example"
    );
    expect(consumeOpaquePairingIntent(sessionStorage)).toBe(
      "http://localhost:3000/orgii/mobile?relay=wss%3A%2F%2Frelay.example#pair=device-intent"
    );
    expect(mocks.login).toHaveBeenCalledOnce();
  });

  it("does not offer the hosted-login bypass for a mobile return target", async () => {
    await renderLogin();

    const skipButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "login.startButton"
    );
    expect(skipButton).toBeUndefined();
    expect(mocks.setAuthSkipped).not.toHaveBeenCalled();
    expect(container.querySelector("output")).toBeNull();
  });

  it("continues offering the bypass for a non-mobile return target", async () => {
    await renderLogin({
      pathname: "/orgii/workstation",
      search: "",
      hash: "",
    });

    const skipButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "login.startButton"
    );
    expect(skipButton).toBeDefined();
  });
});
