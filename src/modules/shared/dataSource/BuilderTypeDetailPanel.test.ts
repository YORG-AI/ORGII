// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BuilderTypeDetailPanel from "./BuilderTypeDetailPanel";
import { getBuilderType } from "./builderTypes";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      key.endsWith(".description")
        ? `${key}。`
        : key.endsWith(".agentTip")
          ? `${key}.`
          : key,
  }),
}));

describe("BuilderTypeDetailPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the selected type profile and agent guidance", () => {
    const type = getBuilderType("EAWH");
    const onBack = vi.fn();
    expect(type).toBeDefined();

    act(() =>
      root.render(
        createElement(BuilderTypeDetailPanel, {
          type: type!,
          onBack,
        })
      )
    );

    const detail = container.querySelector(
      '[data-testid="builder-type-detail"]'
    );
    expect(detail?.textContent).toContain("EAWH");
    expect(detail?.textContent).toContain("Swarm Founder");
    expect(detail?.querySelectorAll("li")).toHaveLength(8);
    expect(detail?.textContent).not.toContain("description。");
    expect(detail?.textContent).not.toContain("agentTip.");
    expect(
      detail?.querySelector('[data-testid="builder-type-avatar-EAWH"]')
    ).not.toBeNull();

    act(() =>
      container
        .querySelector<HTMLButtonElement>(
          '[data-testid="builder-type-detail-back"]'
        )
        ?.click()
    );
    expect(onBack).toHaveBeenCalledOnce();
  });
});
