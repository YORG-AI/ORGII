/**
 * Unit tests for the pure select-all logic in useTauriSelectAllShortcut.ts.
 *
 * We test handleSelectAllEvent directly (exported for testing).
 * The hook wrapper (useTauriSelectAllShortcut) is React-dependent and
 * requires jsdom; it is excluded here (node environment, no jsdom).
 *
 * We set up minimal HTMLInputElement / HTMLTextAreaElement globals for
 * the instanceof checks and inject plain mock objects as targets.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { handleSelectAllEvent } from "../useTauriSelectAllShortcut";

// ============================================================================
// Global stubs for HTMLInputElement / HTMLTextAreaElement instanceof checks
// ============================================================================

class FakeHTMLInputElement {
  readonly _kind = "input" as const;
  select = vi.fn();
}

class FakeHTMLTextAreaElement {
  readonly _kind = "textarea" as const;
  select = vi.fn();
}

let savedInput: typeof globalThis.HTMLInputElement;
let savedTextarea: typeof globalThis.HTMLTextAreaElement;

beforeAll(() => {
  savedInput = globalThis.HTMLInputElement;
  savedTextarea = globalThis.HTMLTextAreaElement;
  globalThis.HTMLInputElement =
    FakeHTMLInputElement as unknown as typeof HTMLInputElement;
  globalThis.HTMLTextAreaElement =
    FakeHTMLTextAreaElement as unknown as typeof HTMLTextAreaElement;
});

afterAll(() => {
  globalThis.HTMLInputElement = savedInput;
  globalThis.HTMLTextAreaElement = savedTextarea;
});

// ============================================================================
// Helpers
// ============================================================================

function makeInputTarget() {
  return new FakeHTMLInputElement();
}

function makeTextareaTarget() {
  return new FakeHTMLTextAreaElement();
}

type EventOverrides = {
  defaultPrevented?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  key?: string;
  target?: object | null;
};

function makeEvent(overrides: EventOverrides = {}) {
  const prevented = { value: overrides.defaultPrevented ?? false };
  return {
    get defaultPrevented() {
      return prevented.value;
    },
    metaKey: overrides.metaKey ?? false,
    ctrlKey: overrides.ctrlKey ?? false,
    shiftKey: overrides.shiftKey ?? false,
    altKey: overrides.altKey ?? false,
    key: overrides.key ?? "a",
    target:
      overrides.target !== undefined ? overrides.target : makeInputTarget(),
    preventDefault: vi.fn(() => {
      prevented.value = true;
    }),
    stopPropagation: vi.fn(),
  };
}

// ============================================================================
// Tests
// ============================================================================

describe("handleSelectAllEvent — happy path", () => {
  it("calls select() and preventDefault on an <input> with ⌘A", () => {
    const target = makeInputTarget();
    const event = makeEvent({ metaKey: true, key: "a", target });
    handleSelectAllEvent(event as never);
    expect(target.select).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(event.stopPropagation).toHaveBeenCalledTimes(1);
  });

  it("calls select() on a <textarea> with Ctrl+A", () => {
    const target = makeTextareaTarget();
    const event = makeEvent({ ctrlKey: true, key: "a", target });
    handleSelectAllEvent(event as never);
    expect(target.select).toHaveBeenCalledTimes(1);
  });

  it("is case-insensitive for the key (uppercase A)", () => {
    const target = makeInputTarget();
    const event = makeEvent({ metaKey: true, key: "A", target });
    handleSelectAllEvent(event as never);
    expect(target.select).toHaveBeenCalledTimes(1);
  });
});

describe("handleSelectAllEvent — guard conditions", () => {
  it("is a no-op when defaultPrevented is true", () => {
    const target = makeInputTarget();
    const event = makeEvent({
      metaKey: true,
      key: "a",
      target,
      defaultPrevented: true,
    });
    handleSelectAllEvent(event as never);
    expect(target.select).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("is a no-op when neither metaKey nor ctrlKey is set", () => {
    const target = makeInputTarget();
    const event = makeEvent({ key: "a", target });
    handleSelectAllEvent(event as never);
    expect(target.select).not.toHaveBeenCalled();
  });

  it("is a no-op when shiftKey is set alongside metaKey", () => {
    const target = makeInputTarget();
    const event = makeEvent({
      metaKey: true,
      shiftKey: true,
      key: "a",
      target,
    });
    handleSelectAllEvent(event as never);
    expect(target.select).not.toHaveBeenCalled();
  });

  it("is a no-op when altKey is set alongside metaKey", () => {
    const target = makeInputTarget();
    const event = makeEvent({ metaKey: true, altKey: true, key: "a", target });
    handleSelectAllEvent(event as never);
    expect(target.select).not.toHaveBeenCalled();
  });

  it("is a no-op for a different key (z)", () => {
    const target = makeInputTarget();
    const event = makeEvent({ metaKey: true, key: "z", target });
    handleSelectAllEvent(event as never);
    expect(target.select).not.toHaveBeenCalled();
  });

  it("is a no-op when target is a plain object (not editable)", () => {
    const event = makeEvent({ metaKey: true, key: "a", target: {} });
    handleSelectAllEvent(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("is a no-op when target is null", () => {
    const event = makeEvent({ metaKey: true, key: "a", target: null });
    handleSelectAllEvent(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it("falls back to document.activeElement when the key event target is not editable", () => {
    const activeElement = makeInputTarget();
    const savedDocument = globalThis.document;
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: { activeElement },
    });

    try {
      const event = makeEvent({ metaKey: true, key: "a", target: {} });
      handleSelectAllEvent(event as never);

      expect(activeElement.select).toHaveBeenCalledTimes(1);
      expect(event.preventDefault).toHaveBeenCalledTimes(1);
      expect(event.stopPropagation).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, "document", {
        configurable: true,
        value: savedDocument,
      });
    }
  });

  it("does not prevent default when the focused input cannot be selected", () => {
    const target = makeInputTarget();
    target.select.mockImplementation(() => {
      throw new Error("selection unsupported");
    });

    const event = makeEvent({ metaKey: true, key: "a", target });
    handleSelectAllEvent(event as never);

    expect(target.select).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(event.stopPropagation).not.toHaveBeenCalled();
  });
});
