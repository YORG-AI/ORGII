import { describe, expect, it } from "vitest";

import {
  shouldShowExternalHistoryForkComposer,
  shouldShowMainChatComposer,
} from "./chatViewComposerVisibility";

describe("chat view composer visibility", () => {
  it("hides the main composer while a cloud transcript is not downloaded", () => {
    expect(
      shouldShowMainChatComposer({
        showInteractArea: true,
        isReadOnlySurface: false,
        hasCloudDownloadSurface: true,
      })
    ).toBe(false);
  });

  it("hides the external-history continuation composer while downloading", () => {
    expect(
      shouldShowExternalHistoryForkComposer({
        isImportedHistory: true,
        readOnly: false,
        canResume: true,
        hasCloudDownloadSurface: true,
      })
    ).toBe(false);
  });
});
