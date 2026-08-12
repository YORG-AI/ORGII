import { describe, expect, it } from "vitest";

import {
  INPUT_AREA_CONTROL_GROUP_CLASS,
  INPUT_AREA_EDITOR_CLASS,
  INPUT_AREA_EDITOR_HEIGHT,
} from "./inputAreaTokens";

describe("input area tokens", () => {
  it("keeps session and launchpad composers on the full-height editor bounds", () => {
    expect(INPUT_AREA_EDITOR_HEIGHT).toEqual({ min: 60, max: 140 });
  });

  it("keeps both editors on the creator presentation classes", () => {
    expect(INPUT_AREA_EDITOR_CLASS).toBe(
      "session-editor flex-1 cursor-text overflow-y-auto rounded-md text-[14px] text-text-1"
    );
  });

  it("keeps mode and model controls on the creator spacing", () => {
    expect(INPUT_AREA_CONTROL_GROUP_CLASS).toBe(
      "flex min-w-0 items-center gap-px"
    );
  });
});
