// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { type SmokeRoot, createSmokeRoot } from "@src/test/reactSmokeHarness";

import {
  invalidateProjectDataChangeCaches,
  parseProjectDataChange,
  projectRosterChangedSignalAtom,
  projectStatusDefinitionsVersionAtom,
  useProjectDataChangedListener,
} from "./useProjectDataChanged";

const mocks = vi.hoisted(() => ({
  invalidateProjectCache: vi.fn(),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
}));

vi.mock("@src/api/http/project", () => ({
  PROJECT_ROSTER_CHANGED_EVENT: "orgii-project-roster-changed",
  PROJECT_STATUS_DEFINITIONS_CHANGED_EVENT:
    "orgii-project-status-definitions-changed",
  invalidateProjectCache: mocks.invalidateProjectCache,
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    (name: string, listener: (event: { payload: unknown }) => void) => {
      mocks.listeners.set(name, listener);
      return Promise.resolve(mocks.unlisten);
    }
  ),
}));

function ListenerHarness(): null {
  useProjectDataChangedListener();
  return null;
}

describe("project data-change scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes scoped wire payloads", () => {
    expect(
      parseProjectDataChange({
        project_slug: "demo",
        work_item_id: "DEM-7",
        repo_path: "/repos/demo",
        source: "test",
      })
    ).toEqual({
      projectSlug: "demo",
      workItemId: "DEM-7",
      repoPath: "/repos/demo",
      source: "test",
    });
    expect(parseProjectDataChange("legacy-payload")).toBeNull();
  });

  it("invalidates only the project and project summaries when scoped", () => {
    invalidateProjectDataChangeCaches({
      projectSlug: "demo",
      workItemId: "DEM-7",
    });

    expect(mocks.invalidateProjectCache.mock.calls).toEqual([
      ["demo"],
      ["__projects__"],
    ]);
  });

  it("flushes safely for repo-path-only and legacy events", () => {
    invalidateProjectDataChangeCaches({ repoPath: "/repos/demo" });
    invalidateProjectDataChangeCaches(null);

    expect(mocks.invalidateProjectCache.mock.calls).toEqual([[], []]);
  });

  it("bumps the roster version only from the narrow cross-window event", async () => {
    const store = createStore();
    const root: SmokeRoot = createSmokeRoot();
    await root.render(
      createElement(Provider, { store }, createElement(ListenerHarness))
    );

    await act(async () => {
      mocks.listeners.get("orgii-data-changed")?.({ payload: null });
    });
    expect(store.get(projectRosterChangedSignalAtom)).toBe(0);

    await act(async () => {
      mocks.listeners.get("orgii-project-roster-changed")?.({ payload: null });
    });
    expect(store.get(projectRosterChangedSignalAtom)).toBe(1);

    await root.unmount();
    await Promise.resolve();
    expect(mocks.unlisten).toHaveBeenCalledTimes(3);
  });

  it("bumps only the addressed org's status catalog version", async () => {
    const store = createStore();
    const root: SmokeRoot = createSmokeRoot();
    await root.render(
      createElement(Provider, { store }, createElement(ListenerHarness))
    );

    await act(async () => {
      mocks.listeners.get("orgii-project-status-definitions-changed")?.({
        payload: { org_id: "org-1" },
      });
    });
    expect(store.get(projectStatusDefinitionsVersionAtom)).toEqual({
      "org-1": 1,
    });
    expect(mocks.invalidateProjectCache).toHaveBeenCalledWith("org-1");

    await root.unmount();
  });
});
