// @vitest-environment jsdom
import { type PrimitiveAtom, Provider, createStore } from "jotai";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { chatPanelHeaderSlotsAtom } from "@src/engines/ChatPanel/header/chatPanelHeaderSlots";
import { activeWorkManagementSectionAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  WORK_MANAGEMENT_SECTION,
  workstationTabHeaderAtomByHost,
} from "@src/store/workstation";

import WorkManagementPage from "./index";

beforeAll(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
afterAll(() => vi.unstubAllGlobals());

vi.mock("@src/components/Placeholder", () => ({
  Placeholder: () => React.createElement("span", null, "Loading"),
}));

vi.mock(
  "@src/engines/ChatPanel/header",
  async () => import("@src/engines/ChatPanel/header/usePublishChatPanelHeader")
);

vi.mock("@src/store/chatPanel/chatPanelTabsAtom", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  const { atom } = await import("jotai");
  return {
    ...original,
    activeWorkManagementSectionAtom: atom("kanban"),
    setActiveWorkManagementSectionAtom: atom(null, () => {}),
  };
});

vi.mock("@src/features/TaskKanban/components/FactoryViewPill", () => ({
  default: () => React.createElement("span", null, "Kanban views"),
}));
vi.mock("@src/features/TaskKanban/components/KanbanOrgScopeSelect", () => ({
  default: () => React.createElement("span", null, "Organization"),
}));
vi.mock("./WorkManagementDatasetSwitch", () => ({
  WorkManagementDatasetSwitch: () =>
    React.createElement("span", null, "Dataset"),
}));
vi.mock("@src/features/TaskKanban", () => ({ default: () => null }));
vi.mock("./WorkManagementTaskCreator", () => ({ default: () => null }));
vi.mock("./WorkManagementProjectsSurface", () => ({ default: () => null }));
vi.mock("./GitHubWorkItemsSurface", () => ({ default: () => null }));
vi.mock("./RoutineRunsSurface", () => ({ default: () => null }));
vi.mock("@src/modules/MainApp/TeamInbox/ConnectedTeamInboxView", () => ({
  default: () => null,
}));

describe("WorkManagementPage header placement", () => {
  it.each([
    { embedded: false, hasTabBar: true },
    { embedded: false, hasTabBar: false },
    { embedded: true, hasTabBar: true },
  ])(
    "keeps delayed Kanban controls below host chrome (%j)",
    async ({ embedded, hasTabBar }) => {
      const store = createStore();
      const container = document.createElement("div");
      const root = createRoot(container);
      const shellAtom = embedded
        ? workstationTabHeaderAtomByHost.code
        : chatPanelHeaderSlotsAtom;
      const observed: unknown[] = [];
      const unsubscribe = store.sub(shellAtom, () => {
        observed.push(store.get(shellAtom));
      });
      try {
        await act(async () => {
          root.render(
            React.createElement(
              Provider,
              { store },
              React.createElement(WorkManagementPage, { embedded, hasTabBar })
            )
          );
        });
        const primary = container.querySelector(
          '[data-split-list-header-row="primary"]'
        );
        expect(primary?.classList.contains("h-9")).toBe(true);
        expect(primary?.textContent).toContain("Kanban views");

        // The lazy board publishes its controls after the host is visible.
        await act(async () => {
          store.set(workstationTabHeaderAtomByHost.workManagement, {
            trailing: React.createElement("input", {
              "aria-label": "Kanban search",
            }),
          });
        });
        expect(
          primary?.querySelector('[aria-label="Kanban search"]')
        ).not.toBeNull();
        expect(observed.length).toBeGreaterThan(0);
        for (const slots of observed) {
          expect(slots).toEqual(
            embedded
              ? { hidden: true, shellLeadingChromeHidden: true }
              : { hidden: hasTabBar }
          );
        }
      } finally {
        await act(async () => root.unmount());
        unsubscribe();
      }
      expect(store.get(shellAtom)).toBeNull();
    }
  );

  it.each([
    WORK_MANAGEMENT_SECTION.INBOX,
    WORK_MANAGEMENT_SECTION.GITHUB_PRS,
    WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
    WORK_MANAGEMENT_SECTION.RUNS,
  ])("does not forward an outgoing Kanban header into %s", async (section) => {
    const store = createStore();
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          React.createElement(
            Provider,
            { store },
            React.createElement(WorkManagementPage, { hasTabBar: false })
          )
        );
      });
      await act(async () => {
        store.set(workstationTabHeaderAtomByHost.workManagement, {
          trailing: React.createElement("span", null, "Outgoing controls"),
        });
      });
      expect(container.textContent).toContain("Outgoing controls");
      await act(async () => {
        // The incoming lazy surface has not yet published `hidden: true`.
        // This atom is writable in the fixture, matching tab selection timing.
        store.set(
          activeWorkManagementSectionAtom as PrimitiveAtom<string>,
          section
        );
      });
      expect(container.textContent).not.toContain("Outgoing controls");
      expect(container.querySelector("[data-split-list-header]")).toBeNull();
      expect(store.get(chatPanelHeaderSlotsAtom)).toEqual({ hidden: false });
      await act(async () => {
        store.set(workstationTabHeaderAtomByHost.workManagement, {
          hidden: true,
        });
      });
      expect(store.get(chatPanelHeaderSlotsAtom)).toEqual({ hidden: false });
    } finally {
      await act(async () => root.unmount());
    }
  });
});
