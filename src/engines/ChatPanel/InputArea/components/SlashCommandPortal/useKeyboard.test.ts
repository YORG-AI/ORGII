// @vitest-environment jsdom
import React, { act } from "react";
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

import type { SlashItem } from "@src/types/extensions";

import type { ListEntry } from "./types";
import { useKeyboard } from "./useKeyboard";

const skill: SlashItem = {
  name: "review-code",
  category: "skill",
  source: "Workspace Skills",
  description: "Review code",
  acceptsArgs: false,
};

describe("useKeyboard", () => {
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

  it("uses Shift+Enter to toggle the highlighted pin without selecting it", () => {
    const entries: ListEntry[] = [{ kind: "item", item: skill, flatIndex: 0 }];
    const onSelect = vi.fn();
    const onTogglePin = vi.fn();
    const keyboardHandlerRef = {
      current: null,
    } as React.MutableRefObject<((event: KeyboardEvent) => boolean) | null>;

    const Harness = () => {
      useKeyboard({
        visible: true,
        entries,
        totalFlat: 1,
        highlightIndex: 0,
        setHighlightIndex: vi.fn(),
        setKeyboardNavigated: vi.fn(),
        onSelect,
        onTogglePin,
        onClose: vi.fn(),
        keyboardHandlerRef,
      });
      return null;
    };

    act(() => root.render(React.createElement(Harness)));

    let handled = false;
    act(() => {
      handled =
        keyboardHandlerRef.current?.(
          new KeyboardEvent("keydown", { key: "Enter", shiftKey: true })
        ) ?? false;
    });

    expect(handled).toBe(true);
    expect(onTogglePin).toHaveBeenCalledWith(skill);
    expect(onSelect).not.toHaveBeenCalled();
  });
});
