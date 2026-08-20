import { describe, expect, it } from "vitest";

import { shouldUseCompactComposerLayout } from "../inputAreaPresentation";

function compactLayout(
  overrides: Partial<Parameters<typeof shouldUseCompactComposerLayout>[0]> = {}
): boolean {
  return shouldUseCompactComposerLayout({
    presentation: "default",
    isChatPanelMaximized: false,
    isEditMode: false,
    hasImages: false,
    isCiteCode: false,
    isReply: false,
    editorMultiline: false,
    ...overrides,
  });
}

describe("shouldUseCompactComposerLayout", () => {
  it("keeps the ordinary non-maximized composer expanded", () => {
    expect(compactLayout()).toBe(false);
  });

  it("uses the shared compact row for a contextual Canvas prompt", () => {
    expect(compactLayout({ presentation: "contextual" })).toBe(true);
  });

  it("expands the contextual prompt when its editor becomes multiline", () => {
    expect(
      compactLayout({ presentation: "contextual", editorMultiline: true })
    ).toBe(false);
  });

  it("uses the shared compact row for the maximized default composer", () => {
    expect(compactLayout({ isChatPanelMaximized: true })).toBe(true);
  });

  it("expands the maximized default composer when its editor becomes multiline", () => {
    expect(
      compactLayout({ isChatPanelMaximized: true, editorMultiline: true })
    ).toBe(false);
  });

  it.each([
    ["edit mode", { isEditMode: true }],
    ["image attachment", { hasImages: true }],
    ["code citation", { isCiteCode: true }],
    ["reply context", { isReply: true }],
  ])("does not compact around %s", (_label, blockedState) => {
    expect(compactLayout({ presentation: "contextual", ...blockedState })).toBe(
      false
    );
  });
});
