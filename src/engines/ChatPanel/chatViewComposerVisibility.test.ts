import { describe, expect, it } from "vitest";

import {
  shouldShowExternalHistoryForkComposer,
  shouldShowMainChatComposer,
} from "./chatViewComposerVisibility";

describe("chat view composer visibility", () => {
  it("hides the main composer only while the first download blocks", () => {
    expect(
      shouldShowMainChatComposer({
        showInteractArea: true,
        isReadOnlySurface: false,
        hasBlockingDownloadSurface: true,
      })
    ).toBe(false);
    expect(
      shouldShowMainChatComposer({
        showInteractArea: true,
        isReadOnlySurface: false,
        hasBlockingDownloadSurface: false,
      })
    ).toBe(true);
  });

  it("hides the continuation composer only while the first download blocks", () => {
    expect(
      shouldShowExternalHistoryForkComposer({
        isImportedHistory: true,
        readOnly: false,
        canResume: true,
        hasBlockingDownloadSurface: true,
      })
    ).toBe(false);
    expect(
      shouldShowExternalHistoryForkComposer({
        isImportedHistory: true,
        readOnly: false,
        canResume: true,
        hasBlockingDownloadSurface: false,
      })
    ).toBe(true);
  });
});
