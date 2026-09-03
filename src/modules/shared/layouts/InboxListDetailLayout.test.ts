// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import InboxListDetailLayout from "./InboxListDetailLayout";

describe("InboxListDetailLayout", () => {
  it("owns the collapsible listener only while the split view is mounted", async () => {
    const actEnvironment = globalThis as typeof globalThis & {
      IS_REACT_ACT_ENVIRONMENT?: boolean;
    };
    const previousActEnvironment = actEnvironment.IS_REACT_ACT_ENVIRONMENT;
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    const add = vi.spyOn(window, "addEventListener");
    const remove = vi.spyOn(window, "removeEventListener");
    const container = document.createElement("div");
    const root = createRoot(container);
    const renderLayout = (detailOpen: boolean) =>
      React.createElement(InboxListDetailLayout, {
        fullContent: React.createElement("div", null, "Full"),
        listHeader: React.createElement("div", null, "Split controls"),
        listContent: React.createElement("div", null, "Compact"),
        detailContent: React.createElement("div", null, "Detail"),
        detailOpen,
      });

    try {
      await act(async () => root.render(renderLayout(false)));
      expect(
        container.firstElementChild?.getAttribute("data-layout-mode")
      ).toBe("single");
      expect(container.textContent).not.toContain("Split controls");
      expect(
        add.mock.calls.filter(([eventName]) => eventName === "keydown")
      ).toHaveLength(0);

      await act(async () => root.render(renderLayout(true)));
      expect(
        container.firstElementChild?.getAttribute("data-layout-mode")
      ).toBe("split");
      expect(
        container.querySelector('[data-compact-list-header="true"]')
      ).not.toBeNull();
      expect(container.textContent).toContain("Split controls");
      const keydownListener = add.mock.calls.find(
        ([eventName]) => eventName === "keydown"
      )?.[1];
      expect(keydownListener).toBeTypeOf("function");

      await act(async () => root.render(renderLayout(false)));
      expect(remove).toHaveBeenCalledWith("keydown", keydownListener);
    } finally {
      await act(async () => root.unmount());
      add.mockRestore();
      remove.mockRestore();
      if (previousActEnvironment === undefined) {
        Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
      } else {
        actEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment;
      }
    }
  });
});
