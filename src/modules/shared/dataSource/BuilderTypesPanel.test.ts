// @vitest-environment jsdom
import { act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BuilderTypesPanel from "./BuilderTypesPanel";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

describe("BuilderTypesPanel", () => {
  let container: HTMLDivElement;
  let root: Root;
  let onBack: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    onBack = vi.fn();
    act(() => root.render(createElement(BuilderTypesPanel, { onBack })));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the complete catalog and four-axis explainer", () => {
    expect(
      container.querySelectorAll('[data-testid^="builder-type-card-"]')
    ).toHaveLength(16);
    expect(container.textContent).toContain("M / E");
    expect(container.textContent).toContain("D / A");
    expect(container.textContent).toContain("F / W");
    expect(container.textContent).toContain("S / H");
  });

  it("separates the code, name, and two preference pairs in each card", () => {
    const systemsArchitect = container.querySelector(
      '[data-testid="builder-type-card-MDFS"]'
    );

    const textColumn = systemsArchitect?.firstElementChild?.lastElementChild;
    const lines = Array.from(textColumn?.children ?? []);
    expect(lines.slice(0, 2).map((line) => line.textContent)).toEqual([
      "MDFS",
      "Systems Architect",
    ]);
    expect(
      Array.from(lines[2]?.children ?? []).map((line) => line.textContent)
    ).toEqual([
      "types.letters.M.name · types.letters.D.name",
      "types.letters.F.name · types.letters.S.name",
    ]);
  });

  it("opens a second-layer detail and returns to the gallery", () => {
    const knowMore = container.querySelector<HTMLButtonElement>(
      '[data-testid="builder-type-know-more-EAWH"]'
    );
    act(() => knowMore?.click());

    expect(
      container.querySelector('[data-testid="builder-type-detail"]')
        ?.textContent
    ).toContain("EAWH");
    expect(
      container.querySelector('[data-testid="builder-types-gallery"]')
    ).toBeNull();

    const back = container.querySelector<HTMLButtonElement>(
      '[data-testid="builder-type-detail-back"]'
    );
    act(() => back?.click());

    expect(
      container.querySelector('[data-testid="builder-types-gallery"]')
    ).not.toBeNull();

    act(() =>
      container
        .querySelector<HTMLButtonElement>('[data-testid="builder-types-back"]')
        ?.click()
    );
    expect(onBack).toHaveBeenCalledOnce();
  });
});
