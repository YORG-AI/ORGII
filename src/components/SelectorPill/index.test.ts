import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import SelectorPill from ".";

describe("SelectorPill", () => {
  it("uses the shared hover and active pill surfaces", () => {
    const idleMarkup = renderToStaticMarkup(
      createElement(SelectorPill, {
        icon: null,
        label: "Skills",
        onClick: vi.fn(),
      })
    );
    const activeMarkup = renderToStaticMarkup(
      createElement(SelectorPill, {
        active: true,
        icon: null,
        label: "Skills",
        onClick: vi.fn(),
      })
    );

    expect(idleMarkup).toContain("enabled:hover:bg-surface-hover!");
    expect(activeMarkup).toContain("bg-surface-hover!");
  });

  it("hides the rest icon while active without a competing display utility", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectorPill, {
        active: true,
        icon: createElement("i", { "data-icon": "probe" }),
        label: "develop",
        onClick: vi.fn(),
      })
    );

    // Tailwind v4 emits display utilities in alphabetical order, so a sibling
    // `inline-flex` outranks `hidden` at equal specificity and would leave the
    // rest icon painted underneath the absolutely positioned chevron.
    const iconSlotClass = /class="([^"]*)"><i data-icon="probe"/.exec(
      markup
    )?.[1];
    expect(iconSlotClass).toBeDefined();
    expect(iconSlotClass).toContain("hidden");
    expect(iconSlotClass).not.toContain("inline-flex");
    expect(markup).toContain('data-icon="chevron-up"');
  });

  it("keeps the hover swap on the idle icon slot", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectorPill, {
        icon: createElement("i", { "data-icon": "probe" }),
        label: "develop",
        onClick: vi.fn(),
      })
    );

    const iconSlotClass = /class="([^"]*)"><i data-icon="probe"/.exec(
      markup
    )?.[1];
    expect(iconSlotClass).toContain("inline-flex");
    expect(iconSlotClass).toContain("group-hover/pill:hidden");
    expect(markup).toContain('data-icon="chevron-down"');
  });

  it("supports a neutral active text treatment", () => {
    const markup = renderToStaticMarkup(
      createElement(SelectorPill, {
        active: true,
        activeTone: "neutral",
        icon: null,
        label: "SDE Agent",
        onClick: vi.fn(),
      })
    );

    expect(markup).toContain("text-text-1");
    expect(markup).not.toContain("text-primary-6");
  });
});
