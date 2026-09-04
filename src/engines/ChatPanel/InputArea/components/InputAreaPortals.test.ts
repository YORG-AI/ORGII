import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { InputAreaPortals } from "./InputAreaPortals";

const mocks = vi.hoisted(() => ({
  contextPortal: vi.fn(),
  slashPortal: vi.fn(),
}));

vi.mock("./ContextMenuPortal", () => ({
  default: (props: unknown) => {
    mocks.contextPortal(props);
    return null;
  },
}));

vi.mock("./SlashCommandPortal", () => ({
  default: (props: unknown) => {
    mocks.slashPortal(props);
    return null;
  },
}));

interface CapturedPortalProps {
  visible?: boolean;
  anchorSelector?: string;
  containerRef?: unknown;
  onImageUpload?: () => void;
  currentMode?: string;
  onModeSelect?: (mode: string) => void;
  items?: Array<{ category: string }>;
}

describe("InputAreaPortals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses one context portal for + and @ while keeping / separate", () => {
    const containerRef = { current: null };
    const onImageUpload = vi.fn();

    renderToStaticMarkup(
      React.createElement(InputAreaPortals, {
        contextMenuVisible: true,
        containerRef,
        onContextMenuClose: vi.fn(),
        onAtSelect: vi.fn(),
        onImageUpload,
        customMentionOptions: [],
        onCustomMentionSelect: vi.fn(),
        atSearchQuery: "",
        contextMenuKeyboardHandlerRef: { current: null },
        isEditMode: false,
        showSlashMenu: false,
        filteredSlashItems: [
          {
            category: "skill",
            name: "compact",
            description: "Compact context",
            source: "builtin",
            acceptsArgs: false,
          },
          {
            category: "action",
            name: "non-skill",
            description: "Not a skill",
            source: "builtin",
            acceptsArgs: false,
          },
        ],
        slashLoading: false,
        currentMode: "build",
        slashQuery: "",
        onSlashCommandClose: vi.fn(),
        onSlashSelect: vi.fn(),
        onContextModeSelect: vi.fn(),
        slashCommandKeyboardHandlerRef: { current: null },
      })
    );

    const contextProps = mocks.contextPortal.mock.calls[0]?.[0] as
      | CapturedPortalProps
      | undefined;
    const slashProps = mocks.slashPortal.mock.calls.map(
      ([props]) => props as CapturedPortalProps
    );

    expect(contextProps).toMatchObject({
      visible: true,
      anchorSelector: "[data-composer-menu-anchor]",
    });
    expect(contextProps?.containerRef).toBe(containerRef);
    expect(contextProps?.onImageUpload).toBe(onImageUpload);
    expect(contextProps?.currentMode).toBe("build");
    expect(contextProps?.onModeSelect).toEqual(expect.any(Function));
    expect(slashProps).toHaveLength(1);
    expect(slashProps[0]).toMatchObject({
      visible: false,
      anchorSelector: "[data-composer-menu-anchor]",
    });
    expect(slashProps[0]?.containerRef).toBe(containerRef);
    expect(slashProps[0]?.onImageUpload).toBeUndefined();
    expect(slashProps[0]?.items).toEqual([
      expect.objectContaining({ category: "skill", name: "compact" }),
    ]);
  });
});
