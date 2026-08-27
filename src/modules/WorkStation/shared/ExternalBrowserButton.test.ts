// @vitest-environment jsdom
import { type ReactNode, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ExternalBrowserButton } from "./ExternalBrowserButton";

const { openExternalLink } = vi.hoisted(() => ({
  openExternalLink: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@src/util/platform/ipcRenderer", () => ({
  openExternalLink,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({
    label,
    children,
  }: {
    label: string;
    children: ReactNode;
  }) =>
    createElement("span", { "data-shortcut-tooltip-label": label }, children),
}));

describe("ExternalBrowserButton", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    openExternalLink.mockClear();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("renders a Chrome button with standard hover and pressed feedback", () => {
    const markup = renderToStaticMarkup(
      createElement(ExternalBrowserButton, {
        href: "https://github.com/openai/example/pull/42",
      })
    );

    expect(markup).toContain(
      'data-shortcut-tooltip-label="Open in external browser"'
    );
    expect(markup).toContain('<button type="button"');
    expect(markup).toContain('aria-label="Open in external browser"');
    expect(markup).toContain('class="lucide lucide-chromium');
    expect(markup).toContain("enabled:hover:bg-surface-hover");
    expect(markup).toContain("enabled:active:bg-surface-selected");
    expect(markup).not.toContain("<a ");
    expect(markup).not.toContain('title="Open in external browser"');
  });

  it("opens the supplied URL through the external-browser API", async () => {
    const onClick = vi.fn();
    act(() => {
      root.render(
        createElement(ExternalBrowserButton, {
          href: "https://github.com/openai/example/issues/42",
          onClick,
        })
      );
    });

    await act(async () => {
      container.querySelector("button")?.click();
    });

    expect(onClick).toHaveBeenCalledOnce();
    expect(openExternalLink).toHaveBeenCalledWith(
      "https://github.com/openai/example/issues/42"
    );
  });
});
