// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ROUTES } from "@src/config/routes";
import {
  buildInitialChatPanelTabsState,
  chatPanelTabsAtom,
  openRuntimeInChatPanelTabAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import {
  chatPanelMaximizedAtom,
  stationChatVisibilityAtom,
} from "@src/store/ui/chatPanelAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  createInstrumentedStore,
  getInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import { WorkStationViewService } from "./WorkStationViewService";

describe("WorkStationViewService work-management tabs", () => {
  const navigationEvents: Array<{ path: string; replace?: boolean }> = [];
  const handleNavigate = (event: Event) => {
    navigationEvents.push(
      (event as CustomEvent<{ path: string; replace?: boolean }>).detail
    );
  };

  beforeEach(() => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
      writable: true,
    });
    createInstrumentedStore();
    const store = getInstrumentedStore();
    store.set(stationModeAtom, "agent-station");
    store.set(stationChatVisibilityAtom, {
      "my-station": true,
      "agent-station": false,
    });
    store.set(chatPanelTabsAtom, buildInitialChatPanelTabsState());
    window.history.replaceState({}, "", ROUTES.workStation.base.path);
    navigationEvents.length = 0;
    window.addEventListener("action-system-navigate", handleNavigate);
  });

  afterEach(() => {
    window.removeEventListener("action-system-navigate", handleNavigate);
  });

  it("applies the same direct-transition rule to Kanban", async () => {
    window.history.replaceState({}, "", ROUTES.app.settings.path);

    await WorkStationViewService.openKanbanTab();

    expect(navigationEvents).toEqual([{ path: ROUTES.workStation.base.path }]);
  });

  it("rejects Station-opening actions for Station-excluded tabs", async () => {
    const store = getInstrumentedStore();
    store.set(openRuntimeInChatPanelTabAtom, "Runtime");

    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(await WorkStationViewService.toggleChatPanelMaximized()).toBe(false);
    expect(await WorkStationViewService.showWorkStation()).toBe(false);
    expect(await WorkStationViewService.openStationMode("my-station")).toBe(
      false
    );
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(store.get(stationModeAtom)).toBe("agent-station");
  });

  it("keeps Station-opening actions disabled on a wide viewport", async () => {
    const store = getInstrumentedStore();
    store.set(openRuntimeInChatPanelTabAtom, "Runtime");
    window.innerWidth = 2560;

    expect(await WorkStationViewService.toggleChatPanelMaximized()).toBe(false);
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(await WorkStationViewService.showWorkStation()).toBe(false);
    expect(await WorkStationViewService.openStationMode("my-station")).toBe(
      false
    );
    expect(store.get(stationModeAtom)).toBe("agent-station");
  });
});
