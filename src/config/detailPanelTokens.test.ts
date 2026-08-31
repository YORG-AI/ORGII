import { describe, expect, it } from "vitest";

import {
  CHAT_PANEL_WIDTH_TOKENS,
  DETAIL_PANEL_TOKENS,
  DETAIL_PANEL_WIDTH_TOKENS,
  ISSUE_PANEL_WIDTH_TOKENS,
} from "./detailPanelTokens";

describe("detail panel width tokens", () => {
  it("keeps standard, chat, and issue widths as separate contracts", () => {
    expect(DETAIL_PANEL_WIDTH_TOKENS.headerWidth).toContain("max-w-[932px]");
    expect(DETAIL_PANEL_WIDTH_TOKENS.contentMaxWidth).toContain(
      "max-w-[900px]"
    );
    expect(CHAT_PANEL_WIDTH_TOKENS.headerWidth).toContain("max-w-[832px]");
    expect(CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth).toContain("max-w-[800px]");
    expect(ISSUE_PANEL_WIDTH_TOKENS.headerWidth).toContain("max-w-[1232px]");
    expect(ISSUE_PANEL_WIDTH_TOKENS.contentMaxWidth).toContain(
      "max-w-[1200px]"
    );
    expect(DETAIL_PANEL_TOKENS.headerWidth).toBe(
      DETAIL_PANEL_WIDTH_TOKENS.headerWidth
    );
    expect(CHAT_PANEL_WIDTH_TOKENS.contentMaxWidth).not.toBe(
      DETAIL_PANEL_WIDTH_TOKENS.contentMaxWidth
    );
  });
});
