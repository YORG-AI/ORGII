import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { SessionDerivedViewShell } from "./SessionDerivedViewShell";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

describe("SessionDerivedViewShell", () => {
  it("renders derived-view load failures as a shared danger InlineAlert", () => {
    const props: ComponentProps<typeof SessionDerivedViewShell> = {
      testId: "session-timeline-view",
      loading: false,
      error: "Timeline unavailable",
      isEmpty: true,
      emptyLabel: "No turns",
      summary: null,
      children: null,
      topInset: 84,
    };
    const markup = renderToStaticMarkup(
      createElement(SessionDerivedViewShell, props)
    );

    expect(markup).toContain('data-testid="session-timeline-view-error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('data-icon="triangle-alert"');
    expect(markup).toContain("shadow-dropdown-soft");
    expect(markup).toContain("Timeline unavailable");
    expect(markup).toContain("padding-top:84px");
  });
});
