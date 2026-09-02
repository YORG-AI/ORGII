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

import { AuthGuard } from "./AuthGuard";

const mocks = vi.hoisted(() => ({
  authSkipped: false,
  isAuthenticated: false,
  logout: vi.fn(),
  refresh: vi.fn(),
}));

vi.mock("@src/config/serviceAuth", () => ({
  isAuthSkipped: () => mocks.authSkipped,
  isServiceAuthenticated: () => false,
}));

vi.mock("@src/hooks/auth", () => ({
  useServiceAuth: () => ({
    isAuthenticated: mocks.isAuthenticated,
    logout: mocks.logout,
    refresh: mocks.refresh,
  }),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const LoginLocationProbe = () => {
  const location = useLocation();
  const from = (
    location.state as {
      from?: { pathname?: string; search?: string; hash?: string };
    } | null
  )?.from;
  return React.createElement("output", {
    "data-pathname": location.pathname,
    "data-from-pathname": from?.pathname,
    "data-from-search": from?.search,
    "data-from-hash": from?.hash,
  });
};

describe("AuthGuard", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    sessionStorage.clear();
    mocks.authSkipped = false;
    mocks.isAuthenticated = false;
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

  it("moves a mobile pairing credential out of the login return location", async () => {
    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          {
            initialEntries: [
              "/orgii/mobile?relay=wss%3A%2F%2Frelay.example#pair=device-intent",
            ],
          },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: "/orgii/mobile",
              element: React.createElement(
                AuthGuard,
                null,
                React.createElement("div", {
                  "data-testid": "mobile-remote",
                })
              ),
            }),
            React.createElement(Route, {
              path: "/orgii/app/login",
              element: React.createElement(LoginLocationProbe),
            })
          )
        )
      );
    });

    const probe = container.querySelector("output");
    expect(probe?.getAttribute("data-pathname")).toBe("/orgii/app/login");
    expect(probe?.getAttribute("data-from-pathname")).toBe("/orgii/mobile");
    expect(probe?.getAttribute("data-from-search")).toBe(
      "?relay=wss%3A%2F%2Frelay.example"
    );
    expect(probe?.getAttribute("data-from-hash")).toBe("");
    expect(consumeOpaquePairingIntent(sessionStorage)).toBe(
      "http://localhost:3000/orgii/mobile?relay=wss%3A%2F%2Frelay.example#pair=device-intent"
    );
    expect(container.querySelector('[data-testid="mobile-remote"]')).toBeNull();
  });

  it("does not let the BYOK auth-skip flag bypass the mobile route guard", async () => {
    mocks.authSkipped = true;

    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/orgii/mobile"] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: "/orgii/mobile",
              element: React.createElement(
                AuthGuard,
                null,
                React.createElement("div", {
                  "data-testid": "mobile-remote",
                })
              ),
            }),
            React.createElement(Route, {
              path: "/orgii/app/login",
              element: React.createElement(LoginLocationProbe),
            })
          )
        )
      );
    });

    expect(container.querySelector("output")).not.toBeNull();
    expect(container.querySelector('[data-testid="mobile-remote"]')).toBeNull();
  });

  it("continues honoring the BYOK auth-skip flag outside the mobile route", async () => {
    mocks.authSkipped = true;

    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/orgii/workstation"] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: "/orgii/workstation",
              element: React.createElement(
                AuthGuard,
                null,
                React.createElement("div", {
                  "data-testid": "workstation",
                })
              ),
            }),
            React.createElement(Route, {
              path: "/orgii/app/login",
              element: React.createElement(LoginLocationProbe),
            })
          )
        )
      );
    });

    expect(
      container.querySelector('[data-testid="workstation"]')
    ).not.toBeNull();
    expect(container.querySelector("output")).toBeNull();
  });

  it("renders the mobile route for an authenticated user", async () => {
    mocks.isAuthenticated = true;

    await act(async () => {
      root.render(
        React.createElement(
          MemoryRouter,
          { initialEntries: ["/orgii/mobile"] },
          React.createElement(
            Routes,
            null,
            React.createElement(Route, {
              path: "/orgii/mobile",
              element: React.createElement(
                AuthGuard,
                null,
                React.createElement("div", {
                  "data-testid": "mobile-remote",
                })
              ),
            })
          )
        )
      );
    });

    expect(
      container.querySelector('[data-testid="mobile-remote"]')
    ).not.toBeNull();
  });
});
