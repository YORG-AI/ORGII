import { describe, expect, it } from "vitest";

import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import { openFileInWorkStation } from "./openFileInWorkStation";

describe("openFileInWorkStation", () => {
  it("explicitly opens WorkStation after a session entry closed it", () => {
    const store = createInstrumentedStore();
    store.set(chatPanelMaximizedAtom, true);

    openFileInWorkStation("/repo/src/main.ts");

    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
  });
});
