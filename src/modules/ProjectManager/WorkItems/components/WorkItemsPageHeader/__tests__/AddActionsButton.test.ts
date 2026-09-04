import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { AddActionsButton } from "../AddActionsButton";

vi.mock("@src/components/KeyboardShortcut/ToolbarTooltip", () => ({
  ToolbarTooltip: ({ children }: { children: React.ReactNode }) => children,
}));

describe("AddActionsButton", () => {
  it.each([
    {
      label: "direct Work Item action",
      onAddProject: undefined,
      onAddWorkItem: vi.fn(),
    },
    {
      label: "combined create menu",
      onAddProject: vi.fn(),
      onAddWorkItem: vi.fn(),
    },
    {
      label: "direct Project action",
      onAddProject: vi.fn(),
      onAddWorkItem: undefined,
    },
  ])("uses the square-pencil icon for the $label", (props) => {
    const markup = renderToStaticMarkup(
      React.createElement(AddActionsButton, {
        ...props,
        addProjectLabel: "Create Project",
        addWorkItemLabel: "Create Work Item",
      })
    );

    expect(markup).toContain('data-icon="square-pen"');
    expect(markup).not.toContain('data-icon="plus"');
  });
});
