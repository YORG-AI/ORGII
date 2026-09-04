import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  toggleWorkManagementCreatorVisibleAtom,
  workManagementCreatorVisibleAtom,
} from "../workManagementCreatorAtom";

describe("workManagementCreatorVisibleAtom", () => {
  it("opens on the first toggle and closes on the second", () => {
    const store = createStore();

    expect(store.get(workManagementCreatorVisibleAtom)).toBe(false);

    store.set(toggleWorkManagementCreatorVisibleAtom);
    expect(store.get(workManagementCreatorVisibleAtom)).toBe(true);

    store.set(toggleWorkManagementCreatorVisibleAtom);
    expect(store.get(workManagementCreatorVisibleAtom)).toBe(false);
  });
});
