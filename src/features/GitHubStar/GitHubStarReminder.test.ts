// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  settingsAtom,
  settingsLoadedAtom,
} from "@src/store/settings/settingsAtom";

import {
  GITHUB_STAR_VALUE_MOMENT_EVENT,
  GitHubStarReminderHost,
  canConsumeGitHubStarValueMoment,
  signalGitHubStarValueMoment,
} from "./GitHubStarReminder";
import {
  type GitHubStarPromptSettings,
  githubStarPromptSettingsAtom,
} from "./promptSettings";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const invokeMock = vi.fn().mockResolvedValue(undefined);

vi.mock("@src/api/tauri/rpc/invoke", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@src/api/tauri/rpc/invoke")>();
  return {
    ...actual,
    rpcCall: (...args: unknown[]) => invokeMock(...args),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("./useGitHubStarController", () => ({
  useGitHubStarController: () => ({
    state: { status: "not-starred" },
    confirmStar: vi.fn(),
    openFallback: vi.fn(),
  }),
}));

function settingsState(
  overrides: Partial<GitHubStarPromptSettings> = {}
): GitHubStarPromptSettings {
  return {
    completed: false,
    disabled: false,
    deferredUntil: 0,
    lastShownAt: 0,
    nextEligibleValueCount: 1,
    ...overrides,
  };
}

describe("GitHub Star reminder state", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    invokeMock.mockClear();
    sessionStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
    vi.restoreAllMocks();
  });

  it("persists all prompt dimensions through the canonical settings atom", () => {
    const store = createStore();
    store.set(
      githubStarPromptSettingsAtom,
      settingsState({
        completed: true,
        disabled: true,
        deferredUntil: 200,
        lastShownAt: 100,
        nextEligibleValueCount: 4,
      })
    );

    expect(store.get(settingsAtom)).toEqual(
      expect.objectContaining({
        "general.githubStarPromptCompleted": true,
        "general.githubStarPromptDisabled": true,
        "general.githubStarPromptDeferredUntil": 200,
        "general.githubStarPromptLastShownAt": 100,
        "general.githubStarPromptNextEligibleValueCount": 4,
      })
    );
  });

  it("keeps a pending value moment untouched until onboarding has closed", () => {
    expect(canConsumeGitHubStarValueMoment("/orgii/app/walkthrough")).toBe(
      false
    );
    expect(canConsumeGitHubStarValueMoment("/orgii/workstation/code")).toBe(
      true
    );
  });

  it("delivers the pending reminder only after navigation leaves onboarding", async () => {
    const store = createStore();
    store.set(settingsLoadedAtom, true);
    store.set(settingsAtom, {
      ...store.get(settingsAtom),
      "general.githubStarPromptCompleted": false,
      "general.githubStarPromptDisabled": false,
      "general.githubStarPromptDeferredUntil": 0,
      "general.githubStarPromptLastShownAt": 0,
      "general.githubStarPromptNextEligibleValueCount": 1,
    });
    sessionStorage.setItem("orgii.githubStar.pendingValueCount", "1");

    const renderAt = (pathname: string) =>
      createElement(
        Provider,
        { store },
        createElement(
          MemoryRouter,
          { initialEntries: [pathname], key: pathname },
          createElement(GitHubStarReminderHost)
        )
      );

    await act(async () => {
      root.render(renderAt("/orgii/app/walkthrough"));
      await Promise.resolve();
    });
    expect(sessionStorage.getItem("orgii.githubStar.pendingValueCount")).toBe(
      "1"
    );
    expect(container.textContent).not.toContain(
      "general.githubStar.reminderTitle"
    );

    await act(async () => {
      root.render(renderAt("/orgii/workstation/code"));
      await Promise.resolve();
    });
    expect(sessionStorage.getItem("orgii.githubStar.pendingValueCount")).toBe(
      null
    );
    expect(document.body.textContent).toContain(
      "general.githubStar.reminderTitle"
    );
    expect(
      store.get(settingsAtom)["general.githubStarPromptLastShownAt"]
    ).toBeGreaterThan(0);
  });

  it("records a pending onboarding value moment and dispatches once", () => {
    const dispatchEventSpy = vi.spyOn(window, "dispatchEvent");

    signalGitHubStarValueMoment(2);

    expect(sessionStorage.getItem("orgii.githubStar.pendingValueCount")).toBe(
      "2"
    );
    expect(dispatchEventSpy).toHaveBeenCalledTimes(1);
    expect(dispatchEventSpy.mock.calls[0]?.[0].type).toBe(
      GITHUB_STAR_VALUE_MOMENT_EVENT
    );
    dispatchEventSpy.mockRestore();
  });
});
