import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import ComposerBar from ".";

describe("ComposerBar", () => {
  it("uses the shared surface for the Skills and Tools trigger", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerBar, {
        onAddContent: vi.fn(),
        onOpenSkillsTools: vi.fn(),
        onUpload: vi.fn(),
        showContextInfo: false,
      })
    );

    expect(markup).toContain('data-testid="composer-skills-tools-button"');
    expect(markup).toContain("!bg-bg-2");
    expect(markup).toContain("enabled:hover:!bg-surface-hover");
  });
});
