// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import CompactListPanel, {
  type CompactListPanelEntry,
} from "./CompactListPanel";

describe("CompactListPanel", () => {
  it("keeps one tabbable row and moves selection with Inbox keys", async () => {
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const selectFirst = vi.fn();
    const selectSecond = vi.fn();
    const entries: CompactListPanelEntry[] = [
      {
        key: "first",
        title: "First",
        leading: React.createElement("span"),
        ariaLabel: "First",
        onSelect: selectFirst,
      },
      {
        key: "second",
        title: "Second",
        leading: React.createElement("span"),
        ariaLabel: "Second",
        onSelect: selectSecond,
      },
    ];
    const container = document.createElement("div");
    const root = createRoot(container);

    try {
      await act(async () => {
        root.render(
          React.createElement(CompactListPanel, {
            ariaLabel: "Items",
            entries,
            selectedEntryKey: "first",
          })
        );
      });
      const options =
        container.querySelectorAll<HTMLButtonElement>('[role="option"]');
      expect(options[0]?.tabIndex).toBe(0);
      expect(options[1]?.tabIndex).toBe(-1);

      await act(async () => {
        container
          .querySelector('[role="listbox"]')
          ?.dispatchEvent(
            new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })
          );
      });
      expect(selectSecond).toHaveBeenCalledOnce();
      expect(selectFirst).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  });

  it("starts directly with list content without a title header", () => {
    const entries: CompactListPanelEntry[] = [
      {
        key: "first",
        title: "First",
        leading: React.createElement("span"),
        ariaLabel: "First",
        onSelect: vi.fn(),
      },
    ];
    const markup = renderToStaticMarkup(
      React.createElement(CompactListPanel, {
        ariaLabel: "Items",
        entries,
        selectedEntryKey: null,
      })
    );

    expect(markup).toContain('role="listbox"');
    expect(markup).toContain("py-1.5!");
    expect(markup).not.toContain("border-b");
    expect(markup).not.toContain(">Items<");
  });
});
