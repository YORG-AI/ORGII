import { createStore } from "jotai/vanilla";

import {
  componentIssueModalOpenAtom,
  hasGlobalErrorAtom,
  quitConfirmationModalOpenAtom,
  toolbarDropdownOpenAtom,
  webviewOverlayBlockedAtom,
} from "../overlayAtom";
import { overlayLayerRegistryAtom } from "../overlayLayerAtom";
import { spotlightOpenAtom } from "../uiAtom";

const platform = vi.hoisted(() => ({ isMacOS: false }));

vi.mock("@src/util/platform/tauri", () => ({
  isMacOS: () => platform.isMacOS,
}));

describe("webviewOverlayBlockedAtom", () => {
  beforeEach(() => {
    platform.isMacOS = false;
  });

  it("uses the offscreen fallback where native layering is unavailable", () => {
    const store = createStore();
    expect(store.get(webviewOverlayBlockedAtom)).toBe(false);

    store.set(overlayLayerRegistryAtom, {
      menu: { id: "menu", rect: null, blocksNativeInput: true },
    });
    expect(store.get(webviewOverlayBlockedAtom)).toBe(true);

    store.set(overlayLayerRegistryAtom, {});
    expect(store.get(webviewOverlayBlockedAtom)).toBe(false);
  });

  it("keeps the page visible on macOS while native layering handles overlays", () => {
    platform.isMacOS = true;
    const store = createStore();

    store.set(overlayLayerRegistryAtom, {
      menu: { id: "menu", rect: null, blocksNativeInput: true },
    });

    expect(store.get(webviewOverlayBlockedAtom)).toBe(false);

    store.set(componentIssueModalOpenAtom, true);
    store.set(quitConfirmationModalOpenAtom, true);
    store.set(toolbarDropdownOpenAtom, true);
    store.set(spotlightOpenAtom, true);
    expect(store.get(webviewOverlayBlockedAtom)).toBe(false);

    store.set(hasGlobalErrorAtom, true);
    expect(store.get(webviewOverlayBlockedAtom)).toBe(true);
  });
});
