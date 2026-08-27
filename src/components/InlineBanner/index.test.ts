// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
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

import InlineBanner, { useDismissibleMessage } from ".";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

/** Mirrors how a panel wires a transient error into the sticky banner. */
const Harness: React.FC<{ error: string | null }> = ({ error }) => {
  const { visibleMessage, dismiss } = useDismissibleMessage(error);
  return visibleMessage
    ? React.createElement(
        InlineBanner,
        { onDismiss: dismiss, dataTestId: "banner" },
        visibleMessage
      )
    : null;
};

describe("InlineBanner", () => {
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
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  const render = (error: string | null) => {
    act(() => {
      root.render(React.createElement(Harness, { error }));
    });
  };

  it("keeps a message on screen after its source clears", () => {
    render("OAuth App access restrictions are enabled");
    expect(
      container.querySelector("[data-testid='banner']")?.textContent
    ).toContain("OAuth App access restrictions are enabled");

    // A successful background reconcile resets the panel's error — the banner
    // must not disappear with it.
    render(null);
    expect(
      container.querySelector("[data-testid='banner']")?.textContent
    ).toContain("OAuth App access restrictions are enabled");
  });

  it("closes only when dismissed, and reopens for a new message", () => {
    render("First failure");
    act(() => {
      container
        .querySelector<HTMLButtonElement>("[data-testid='banner-dismiss']")
        ?.click();
    });
    expect(container.querySelector("[data-testid='banner']")).toBeNull();

    // Dismissing one message must not suppress the next one.
    render("Second failure");
    expect(
      container.querySelector("[data-testid='banner']")?.textContent
    ).toContain("Second failure");
  });

  it("uses semantic tones that exist in the palette", () => {
    // The danger/warning scales stop at 6, so a `-7` step renders no class.
    act(() => {
      root.render(
        React.createElement(
          InlineBanner,
          { dataTestId: "banner", tone: "danger" as const },
          "Broken"
        )
      );
    });
    const banner = container.querySelector("[data-testid='banner']");
    expect(banner?.className).toContain("text-danger-6");
    expect(banner?.className).not.toContain("danger-7");
    // No dismiss control unless the host supplies one.
    expect(
      container.querySelector("[data-testid='banner-dismiss']")
    ).toBeNull();
  });
});
