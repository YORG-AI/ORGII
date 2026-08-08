import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import { APPLICATION_PREVIEW_STYLE } from "@src/config/appearance/applicationPreviewStyle";

import { applicationPreviewStyleAtom } from "../globalPreferencesPanelAtom";

describe("applicationPreviewStyleAtom", () => {
  it("stores supported preview styles", () => {
    const store = createStore();

    store.set(applicationPreviewStyleAtom, APPLICATION_PREVIEW_STYLE.MASCOT);

    expect(store.get(applicationPreviewStyleAtom)).toBe(
      APPLICATION_PREVIEW_STYLE.MASCOT
    );
  });

  it("recovers unsupported values to compact", () => {
    const store = createStore();

    store.set(applicationPreviewStyleAtom, "unsupported");

    expect(store.get(applicationPreviewStyleAtom)).toBe(
      APPLICATION_PREVIEW_STYLE.COMPACT
    );
  });
});
