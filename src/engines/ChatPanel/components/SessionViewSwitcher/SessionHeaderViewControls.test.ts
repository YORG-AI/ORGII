// @vitest-environment jsdom
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { SelectProps } from "@src/components/Select";

import type { UseSessionViewModeResult } from "../../hooks/useSessionViewMode";
import {
  SESSION_VIEW_SELECTOR_CLASS,
  SessionHeaderViewControls,
} from "./index";

vi.mock("@src/components/Select", () => ({
  default: ({ dataTestId, selectorClassName, ariaLabel }: SelectProps) =>
    React.createElement("div", {
      "data-testid": dataTestId,
      "data-selector-class": selectorClassName,
      "aria-label": ariaLabel,
    }),
}));

vi.mock("../SessionHeaderBreadcrumb", () => ({
  default: () => React.createElement("div", { "data-testid": "breadcrumb" }),
}));

function view(): UseSessionViewModeResult {
  return {
    mode: "timeline",
    isRaw: false,
    switchable: true,
    options: [
      {
        value: "timeline",
        label: "Timeline",
        icon: React.createElement("span", null, "icon"),
      },
    ],
    onChange: vi.fn(),
    showRaw: vi.fn(),
    transcript: {} as UseSessionViewModeResult["transcript"],
  };
}

describe("SessionHeaderViewControls", () => {
  it("shows only the selected icon and chevron when its own header area is narrow", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SessionHeaderViewControls, {
        session: null,
        sessionId: "session-1",
        fallbackName: "Session",
        view: view(),
        testIdPrefix: "chat-panel-session",
      })
    );
    document.body.innerHTML = markup;

    const select = document.querySelector(
      '[data-testid="chat-panel-session-view-select"]'
    );
    const selectorClass = select?.getAttribute("data-selector-class") ?? "";

    expect(selectorClass).toBe(SESSION_VIEW_SELECTOR_CLASS);
    expect(selectorClass).toContain("[&_.select-value>span:last-child]:hidden");
    expect(selectorClass).toContain(
      "@[600px]/sessionview:[&_.select-value>span:last-child]:inline"
    );
    expect(select?.parentElement?.className).toContain(
      "@container/sessionview"
    );
    expect(select?.getAttribute("aria-label")).toBe("Timeline");
  });
});
