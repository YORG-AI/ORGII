// @vitest-environment jsdom
import React, { act, createElement, createRef } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ComposerInputRef } from "@src/components/ComposerInput";

import PinnedActionsBar, { getUnresolvedPinnedSkillsKey } from ".";

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtom: () => [
    [{ name: "canvas", category: "action", source: "builtin" }],
    vi.fn(),
  ],
  useAtomValue: () => [],
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }),
}));

vi.mock("@src/components/Button", async () => {
  const ReactModule = await import("react");
  return {
    default: ReactModule.forwardRef(
      (
        props: {
          children?: React.ReactNode;
          onClick?: React.MouseEventHandler<HTMLButtonElement>;
          title?: string;
        },
        ref: React.ForwardedRef<HTMLButtonElement>
      ) =>
        ReactModule.createElement(
          "button",
          { ref, onClick: props.onClick, title: props.title },
          props.children
        )
    ),
  };
});

vi.mock("@src/components/FileTreePreview/exports", () => ({
  FileTreeHoverPreview: ({ children }: { children: React.ReactNode }) =>
    children,
}));

vi.mock(
  "@src/engines/ChatPanel/blocks/CanvasInlineCard/useCanvasForTurn",
  () => ({
    useCanvasForTurn: () => ({
      snapshot: { isDismissed: false, latestPayload: null },
      clearCanvas: vi.fn(),
    }),
  })
);

vi.mock("@src/engines/ChatPanel/hooks/useInputArea/useSlashItemsCache", () => ({
  useSlashItemsCache: () => ({
    fetchFresh: vi.fn(async () => []),
    filteredItems: [],
    loading: false,
  }),
}));

vi.mock("./PinActionsPanel", () => ({
  default: () => null,
}));

describe("PinnedActionsBar", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("inserts the pinned Canvas action as an atomic command pill", () => {
    const insertFilePill = vi.fn();
    const focus = vi.fn();
    const composerInputRef = createRef<ComposerInputRef>();
    composerInputRef.current = {
      focus,
      insertFilePill,
    } as unknown as ComposerInputRef;

    act(() =>
      root.render(createElement(PinnedActionsBar, { composerInputRef }))
    );

    // The CREATION action renders a distinct label so it never reads as a
    // duplicate of the "Canvas" preview-reopen button.
    const canvasButton = container.querySelector<HTMLButtonElement>(
      'button[title="New Canvas"]'
    );
    expect(canvasButton).not.toBeNull();
    expect(canvasButton?.textContent).toBe("New Canvas");

    act(() => canvasButton?.click());

    expect(insertFilePill).toHaveBeenCalledWith(
      "/canvas",
      false,
      "skill",
      "canvas"
    );
    expect(focus).toHaveBeenCalledOnce();
  });

  it("hides pinned pills together with the divider and management button", () => {
    const composerInputRef = createRef<ComposerInputRef>();

    act(() =>
      root.render(
        createElement(PinnedActionsBar, {
          composerInputRef,
          leadingContent: createElement("span", null, "Setup controls"),
          manageButtonPlacement: "before-actions",
          showPinnedActions: false,
        })
      )
    );

    expect(
      container.querySelector<HTMLButtonElement>('button[title="New Canvas"]')
    ).toBeNull();
    expect(
      container.querySelector<HTMLButtonElement>(
        'button[title="input.pinnedActions.manage"]'
      )
    ).toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
    expect(container.textContent).toContain("Setup controls");
  });

  it("omits the leading divider when the preceding GUI/TUI control is absent", () => {
    const composerInputRef = createRef<ComposerInputRef>();

    act(() =>
      root.render(
        createElement(PinnedActionsBar, {
          composerInputRef,
          manageButtonPlacement: "before-actions",
          showBeforeActionsSeparator: false,
        })
      )
    );

    expect(
      container.querySelector<HTMLButtonElement>(
        'button[title="input.pinnedActions.manage"]'
      )
    ).not.toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });

  it("does not request skill resolution for hidden pinned pills", () => {
    const unresolvedSkill = {
      name: "review",
      category: "skill" as const,
      source: "workspace",
    };

    expect(getUnresolvedPinnedSkillsKey([unresolvedSkill], false)).toBe("");
    expect(getUnresolvedPinnedSkillsKey([unresolvedSkill], true)).toBe(
      "review"
    );
  });
});
