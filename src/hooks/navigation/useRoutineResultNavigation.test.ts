import { Provider } from "jotai";
import React from "react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ROUTES } from "@src/config/routes";
import { chatPanelTabsAtom } from "@src/store/chatPanel/chatPanelTabsAtom";
import { stationModeAtom } from "@src/store/ui/simulatorAtom";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { useRoutineResultNavigation } from "./useRoutineResultNavigation";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  readStandaloneWorkItem: vi.fn(),
  workItemDataToUI: vi.fn(),
}));

vi.mock("react-router-dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router-dom")>()),
  useNavigate: () => mocks.navigate,
}));

vi.mock("@src/api/http/project", () => ({
  projectApi: {
    readStandaloneWorkItem: mocks.readStandaloneWorkItem,
  },
  workItemDataToUI: mocks.workItemDataToUI,
}));

describe("useRoutineResultNavigation", () => {
  beforeEach(() => {
    mocks.navigate.mockReset();
    mocks.readStandaloneWorkItem.mockReset();
    mocks.workItemDataToUI.mockReset();
  });

  it("opens a standalone Work Item in My Station and navigates there", async () => {
    const storedWorkItem = {
      frontmatter: {
        id: "work-item-1",
        short_id: "WI-0001",
        title: "Routine result",
      },
      body: "",
      filename: "WI-0001.md",
    };
    const uiWorkItem = {
      session_id: "WI-0001",
      name: "Routine result",
    };
    mocks.readStandaloneWorkItem.mockResolvedValue(storedWorkItem);
    mocks.workItemDataToUI.mockReturnValue(uiWorkItem);

    const store = createInstrumentedStore();
    let openResult: ReturnType<typeof useRoutineResultNavigation> | undefined;

    function HookProbe(): null {
      // Test probe: capture the hook API synchronously from server rendering.
      // eslint-disable-next-line react-hooks/globals -- server-rendered test probe synchronously exports the hook callback; the component never mounts or re-renders
      openResult = useRoutineResultNavigation();
      return null;
    }

    renderToString(
      React.createElement(Provider, { store }, React.createElement(HookProbe))
    );

    await openResult?.({ workItemId: "WI-0001" });

    expect(mocks.readStandaloneWorkItem).toHaveBeenCalledWith("WI-0001");
    expect(store.get(stationModeAtom)).toBe("my-station");
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      tabs: expect.arrayContaining([
        expect.objectContaining({
          type: "work-item",
          workItem: expect.objectContaining({ shortId: "WI-0001" }),
        }),
      ]),
    });
    expect(mocks.navigate).toHaveBeenCalledWith(ROUTES.workStation.base.path);
  });
});
