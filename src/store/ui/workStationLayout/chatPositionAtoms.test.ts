import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSettingsDefaults } from "@src/config/settingsSchema";
import { settingsAtom } from "@src/store/settings";

import { chatPanelPositionAtom } from "./chatPositionAtoms";

const { rpcCallMock } = vi.hoisted(() => ({
  rpcCallMock: vi.fn(),
}));

vi.mock("@src/api/tauri/rpc/invoke", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@src/api/tauri/rpc/invoke")>();

  return {
    ...actual,
    rpcCall: rpcCallMock,
  };
});

describe("chatPanelPositionAtom", () => {
  beforeEach(() => {
    rpcCallMock.mockReset();
    rpcCallMock.mockResolvedValue(undefined);
  });

  it("reads and writes the one canonical station-independent setting", () => {
    const store = createStore();
    store.set(settingsAtom, {
      ...getSettingsDefaults(),
      "general.chatPanelPosition": "right",
    });

    expect(store.get(chatPanelPositionAtom)).toBe("right");

    store.set(chatPanelPositionAtom, "left");

    expect(store.get(chatPanelPositionAtom)).toBe("left");
    expect(store.get(settingsAtom)["general.chatPanelPosition"]).toBe("left");
  });
});
