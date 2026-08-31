// @vitest-environment jsdom
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  SESSION_ROW_PRESENTATION,
  SessionRowStatusDot,
} from "./SessionRowPresentation";

describe("SessionRowPresentation", () => {
  it("owns the Desktop sidebar row geometry and typography", () => {
    expect(SESSION_ROW_PRESENTATION.row).toContain("h-8");
    expect(SESSION_ROW_PRESENTATION.leadingIcon).toContain("h-3.5");
    expect(SESSION_ROW_PRESENTATION.title).toContain("text-[13px]");
    expect(SESSION_ROW_PRESENTATION.subtitle).toContain("text-[11px]");
  });

  it("keeps the canonical working color and accessible label", () => {
    const host = document.createElement("div");
    host.innerHTML = renderToStaticMarkup(
      createElement(SessionRowStatusDot, {
        tone: "working",
        label: "Working",
      })
    );

    const dot = host.querySelector<HTMLElement>('[aria-label="Working"]');
    expect(dot).not.toBe(null);
    expect(dot?.className).toContain("opacity-90");
    expect(dot?.style.backgroundColor).toBe("var(--color-primary-6)");
  });
});
