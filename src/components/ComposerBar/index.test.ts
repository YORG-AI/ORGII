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

  it("uses the same toolbar row beneath an editor slot", () => {
    const markup = renderToStaticMarkup(
      createElement(ComposerBar, {
        editorSlot: createElement("span", null, "Editor"),
        showContextInfo: false,
      })
    );

    expect(markup).toContain("flex w-full flex-col gap-2");
    expect(markup).toContain('data-editor-slot="true"');
    expect(markup).toContain(
      "h-9 min-h-9 w-full items-center justify-between px-1"
    );
    expect(markup).toContain("flex min-w-0 items-center gap-0.5");
    expect(markup).not.toContain("display:grid");
  });
});
