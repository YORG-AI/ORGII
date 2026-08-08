// @vitest-environment jsdom
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { I18nextProvider } from "react-i18next";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import i18n from "@src/i18n";

import SetupApplicationPreview from "../SetupApplicationPreview";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe("SetupApplicationPreview", () => {
  let container: HTMLDivElement;
  let root: Root;

  const preview = () =>
    React.createElement(
      I18nextProvider,
      { i18n },
      React.createElement(SetupApplicationPreview)
    );

  const renderPreview = async () => {
    await act(async () => {
      root.render(preview());
    });
  };

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await renderPreview();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("switches the local preview surface and can return to SDE Agent", () => {
    const sdeTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="setup-preview-tab-sde"]'
    );
    const teamInboxTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="setup-preview-tab-team-inbox"]'
    );
    const workItemsTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="setup-preview-tab-work-items"]'
    );

    expect(sdeTab?.getAttribute("aria-selected")).toBe("true");
    expect(
      container.querySelector('[data-testid="setup-preview-panel-sde"]')
    ).not.toBeNull();

    act(() => teamInboxTab?.click());
    expect(teamInboxTab?.getAttribute("aria-selected")).toBe("true");
    expect(
      container.querySelector('[data-testid="setup-preview-panel-team-inbox"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="setup-preview-panel-sde"]')
    ).toBeNull();

    act(() => workItemsTab?.click());
    expect(workItemsTab?.getAttribute("aria-selected")).toBe("true");
    expect(
      container.querySelector('[data-testid="setup-preview-panel-work-items"]')
    ).not.toBeNull();

    act(() => sdeTab?.click());
    expect(sdeTab?.getAttribute("aria-selected")).toBe("true");
    expect(
      container.querySelector('[data-testid="setup-preview-composer"]')
    ).not.toBeNull();
  });

  it("shows fully readable code beside the active preview surface", () => {
    const filesToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="setup-preview-files-toggle"]'
    );
    const teamInboxTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="setup-preview-tab-team-inbox"]'
    );

    act(() => teamInboxTab?.click());

    expect(filesToggle?.closest("header")).not.toBeNull();
    expect(filesToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(
      container.querySelector('[data-testid="setup-preview-code-panel"]')
    ).toBeNull();

    act(() => filesToggle?.click());
    expect(filesToggle?.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector('[data-testid="setup-preview-content-area"]')
        ?.className
    ).toContain("grid-cols-2");
    expect(
      container.querySelector('[data-testid="setup-preview-code-panel"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="setup-preview-workspace"]')
        ?.className
    ).toContain("overflow-hidden");
    expect(
      container.querySelector('[data-testid="setup-preview-code-editor"]')
        ?.textContent
    ).toContain('agent = Agent("SDE")');
    expect(
      container.querySelector('[data-testid="setup-preview-code-editor"]')
        ?.textContent
    ).toContain('agent.run("build")');
    expect(
      container.querySelector('[data-testid="setup-preview-code-editor"]')
        ?.children
    ).toHaveLength(8);
    expect(
      container
        .querySelector('[data-testid="setup-preview-tab-team-inbox"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="setup-preview-panel-team-inbox"]')
    ).not.toBeNull();

    act(() => filesToggle?.click());
    expect(filesToggle?.getAttribute("aria-expanded")).toBe("false");
    expect(
      container.querySelector('[data-testid="setup-preview-code-panel"]')
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="setup-preview-tab-team-inbox"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="setup-preview-panel-team-inbox"]')
    ).not.toBeNull();
  });

  it("shows the localized icon label in a small hover tooltip", async () => {
    const teamInboxTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="setup-preview-tab-team-inbox"]'
    );
    const label = teamInboxTab?.getAttribute("aria-label");

    expect(label).toBeTruthy();

    await act(async () => {
      teamInboxTab?.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true })
      );
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    expect(document.querySelector(".native-tooltip-content")?.textContent).toBe(
      label
    );
  });

  it("returns to SDE Agent after the preview remounts", async () => {
    const teamInboxTab = container.querySelector<HTMLButtonElement>(
      '[data-testid="setup-preview-tab-team-inbox"]'
    );
    const filesToggle = container.querySelector<HTMLButtonElement>(
      '[data-testid="setup-preview-files-toggle"]'
    );
    act(() => teamInboxTab?.click());
    act(() => filesToggle?.click());

    expect(
      container.querySelector('[data-testid="setup-preview-code-panel"]')
    ).not.toBeNull();

    await act(async () => {
      root.render(null);
    });
    await renderPreview();

    expect(
      container
        .querySelector('[data-testid="setup-preview-tab-sde"]')
        ?.getAttribute("aria-selected")
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="setup-preview-panel-sde"]')
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="setup-preview-code-panel"]')
    ).toBeNull();
    expect(
      container
        .querySelector('[data-testid="setup-preview-files-toggle"]')
        ?.getAttribute("aria-expanded")
    ).toBe("false");
  });
});
