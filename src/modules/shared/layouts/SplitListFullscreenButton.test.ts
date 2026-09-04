import { type ReactNode, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SplitListFullscreenButton from "./SplitListFullscreenButton";

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({
    children,
    label,
  }: {
    children: ReactNode;
    label: string;
  }) => createElement("span", { "data-tooltip-label": label }, children),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("SplitListFullscreenButton", () => {
  it("uses the shared tertiary button treatment for both states", () => {
    const maximized = renderToStaticMarkup(
      createElement(SplitListFullscreenButton, {
        isFullscreen: false,
        onToggle: vi.fn(),
      })
    );
    const restored = renderToStaticMarkup(
      createElement(SplitListFullscreenButton, {
        isFullscreen: true,
        onToggle: vi.fn(),
      })
    );

    expect(maximized).toContain('data-testid="split-list-fullscreen-toggle"');
    expect(maximized).toContain(
      'aria-label="windowChrome.items.maximizeRestore"'
    );
    expect(maximized).toContain(
      'data-tooltip-label="windowChrome.items.maximizeRestore"'
    );
    expect(maximized).not.toContain('title="');
    expect(maximized).toContain('data-icon="maximize-2"');
    expect(restored).toContain(
      'aria-label="windowChrome.items.maximizeRestore"'
    );
    expect(restored).toContain('data-icon="minimize-2"');
  });
});
