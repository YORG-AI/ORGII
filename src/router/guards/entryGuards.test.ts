// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
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

import { ROUTES } from "@src/config/routes";
import {
  rawSettingsAtom,
  settingsAtom,
  settingsLoadedAtom,
} from "@src/store/settings/settingsAtom";

import { resolveSetupReturnPath } from "../entryFlow";
import { AppEntryRedirect } from "./AppEntryRedirect";
import { AppShellGate } from "./AppShellGate";

vi.mock("@src/modules/shared/layouts/blocks", () => ({
  Placeholder: () =>
    React.createElement("div", { "data-testid": "entry-loading" }),
}));

const LocationProbe = () => {
  const location = useLocation();
  const from = (location.state as { from?: Location } | null)?.from;
  return React.createElement("div", {
    "data-testid": "location",
    "data-path": `${location.pathname}${location.search}${location.hash}`,
    "data-from": from
      ? `${from.pathname}${from.search}${from.hash}`
      : undefined,
  });
};

describe("entry guards", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  const createSettingsStore = ({
    loaded = true,
    outcome = "open",
    raw = {},
  }: {
    loaded?: boolean;
    outcome?: "open" | "completed" | "dismissed";
    raw?: Record<string, unknown> | null;
  } = {}) => {
    const store = createStore();
    store.set(settingsLoadedAtom, loaded);
    store.set(rawSettingsAtom, raw);
    store.set(settingsAtom, {
      ...store.get(settingsAtom),
      "general.setupWalkthroughOutcome": outcome,
    });
    return store;
  };

  const renderGuard = async (
    initialPath: string,
    store = createSettingsStore()
  ) => {
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(
            MemoryRouter,
            { initialEntries: [initialPath] },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, {
                path: "*",
                element: React.createElement(
                  AppShellGate,
                  null,
                  React.createElement(LocationProbe)
                ),
              })
            )
          )
        )
      );
      await Promise.resolve();
    });
  };

  const renderRootRedirect = async (store = createSettingsStore()) => {
    await act(async () => {
      root.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(
            MemoryRouter,
            { initialEntries: ["/"] },
            React.createElement(
              Routes,
              null,
              React.createElement(Route, {
                path: "/",
                element: React.createElement(AppEntryRedirect),
              }),
              React.createElement(Route, {
                path: "*",
                element: React.createElement(LocationProbe),
              })
            )
          )
        )
      );
      await Promise.resolve();
    });
  };

  it("routes a hydrated first run from root into setup", async () => {
    await renderRootRedirect();

    expect(
      container.querySelector<HTMLElement>('[data-testid="location"]')?.dataset
        .path
    ).toBe(ROUTES.auth.setup.path);
  });

  it("routes an existing install from root into Workstation", async () => {
    await renderRootRedirect(
      createSettingsStore({ outcome: "dismissed", raw: {} })
    );

    expect(
      container.querySelector<HTMLElement>('[data-testid="location"]')?.dataset
        .path
    ).toBe(ROUTES.workStation.base.path);
  });

  it("waits for settings before resolving the local-first root entry", async () => {
    await renderRootRedirect(createSettingsStore({ loaded: false }));

    expect(
      container.querySelector('[data-testid="entry-loading"]')
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="location"]')).toBeNull();
  });

  it("preserves a protected deep link through first-run setup", async () => {
    const target = "/orgii/app/settings?source=deep-link#appearance";
    await renderGuard(target);

    const setupPath = container.querySelector<HTMLElement>(
      '[data-testid="location"]'
    )?.dataset.path;
    expect(setupPath?.startsWith(`${ROUTES.auth.setup.path}?`)).toBe(true);
    expect(
      resolveSetupReturnPath(new URL(setupPath!, "https://orgii.local").search)
    ).toBe(target);
  });

  it("does not interrupt completed or failed-hydration installs", async () => {
    const target = "/orgii/workstation/browser?tab=docs#current";
    await renderGuard(
      target,
      createSettingsStore({ outcome: "completed", raw: {} })
    );
    expect(
      container.querySelector<HTMLElement>('[data-testid="location"]')?.dataset
        .path
    ).toBe(target);

    act(() => root.unmount());
    root = createRoot(container);
    await renderGuard(
      target,
      createSettingsStore({ outcome: "open", raw: null })
    );
    expect(
      container.querySelector<HTMLElement>('[data-testid="location"]')?.dataset
        .path
    ).toBe(target);
  });

  it("keeps protected UI unmounted until settings hydration finishes", async () => {
    await renderGuard(
      "/orgii/workstation",
      createSettingsStore({ loaded: false })
    );

    expect(
      container.querySelector('[data-testid="entry-loading"]')
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="location"]')).toBeNull();
  });

  it("lets the OAuth callback complete before settings hydration", async () => {
    const callbackPath = `${ROUTES.app.market.callback.path}?code=one-time-code`;
    await renderGuard(callbackPath, createSettingsStore({ loaded: false }));

    expect(
      container.querySelector<HTMLElement>('[data-testid="location"]')?.dataset
        .path
    ).toBe(callbackPath);
    expect(container.querySelector('[data-testid="entry-loading"]')).toBeNull();
  });

  it("keeps the local shell available without product identity", async () => {
    const target = "/orgii/app/settings?source=deep-link#appearance";
    await renderGuard(
      target,
      createSettingsStore({ outcome: "dismissed", raw: {} })
    );

    const location = container.querySelector<HTMLElement>(
      '[data-testid="location"]'
    );
    expect(location?.dataset.path).toBe(target);
    expect(location?.dataset.from).toBeUndefined();
  });
});
