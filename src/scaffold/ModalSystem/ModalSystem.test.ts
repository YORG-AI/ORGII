// @vitest-environment jsdom
/**
 * Opening focus for every dialog built on the shared Modal.
 *
 * The rule: when a dialog opens, the caret lands in the first field the user
 * is expected to fill. Before this was enforced here, the header's close
 * button won — it is the first focusable node in DOM order — and the modal's
 * own deferred focus call also stole focus back from fields that had set
 * `autoFocus` themselves.
 */
import { act, createElement } from "react";
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

import Modal from "./index";

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

/** Past the modal's deferred focus tick. */
const OPEN_FOCUS_DELAY_MS = 150;

describe("Modal opening focus", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  function openModal(children: React.ReactNode) {
    act(() => {
      root.render(
        createElement(
          Modal,
          { visible: true, title: "Create channel" },
          children
        )
      );
    });
    act(() => {
      vi.advanceTimersByTime(OPEN_FOCUS_DELAY_MS);
    });
  }

  it("focuses the first field instead of the header close button", () => {
    openModal([
      createElement("input", { key: "name", "data-testid": "name" }),
      createElement("input", { key: "topic", "data-testid": "topic" }),
    ]);

    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="name"]')
    );
  });

  it("focuses a textarea when it is the first field", () => {
    openModal(createElement("textarea", { "data-testid": "body" }));

    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="body"]')
    );
  });

  it("skips disabled and read-only fields", () => {
    openModal([
      createElement("input", { key: "a", disabled: true, "data-testid": "a" }),
      createElement("input", { key: "b", readOnly: true, "data-testid": "b" }),
      createElement("input", { key: "c", "data-testid": "c" }),
    ]);

    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="c"]')
    );
  });

  it("ignores checkboxes and radios, which are actions rather than entry", () => {
    openModal([
      createElement("input", {
        key: "opt",
        type: "checkbox",
        "data-testid": "opt",
      }),
      createElement("input", { key: "name", "data-testid": "name" }),
    ]);

    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="name"]')
    );
  });

  it("leaves focus where the body put it", () => {
    // `autoFocus` inside a dialog body is an explicit choice by its author;
    // the deferred focus must not pull the caret back to the first field.
    openModal([
      createElement("input", { key: "first", "data-testid": "first" }),
      createElement("input", {
        key: "second",
        autoFocus: true,
        "data-testid": "second",
      }),
    ]);

    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="second"]')
    );
  });

  it("still falls back to the primary action when there is no field", () => {
    openModal(
      createElement(
        "button",
        {
          type: "button",
          "data-modal-primary-action": true,
          "data-testid": "ok",
        },
        "OK"
      )
    );

    expect(document.activeElement).toBe(
      document.querySelector('[data-testid="ok"]')
    );
  });
});
