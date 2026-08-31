// @vitest-environment jsdom
/**
 * useSelector — closed-palette focus-steal regression.
 *
 * 2026-06 incident: the refocus effect keyed on the raw `items` array (a
 * fresh reference every parent render) with no isOpen gate. A CLOSED
 * WorkspacePalette mounted under the session-creator page therefore re-fired
 * the effect on every parent render, each run queuing setTimeout(0) →
 * input.focus() — ~700 focus steals per second, blurring the composer the
 * user was typing in and feeding back into more renders.
 *
 * These tests mount the kernel under a real renderer, hand it a fresh items
 * array every render (exactly what real palettes do), and assert the palette
 * input's focus() is never called while closed or on same-content reference
 * churn — plus a positive control that real content changes still refocus.
 */
import { type ReactElement, createElement, useEffect, useState } from "react";
import {
  type MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  type SmokeRoot,
  createSmokeRoot,
  dispatch,
  settle,
} from "@src/test/reactSmokeHarness";

import type { SpotlightItem } from "../../../types";
import { useSelector } from "../useSelector";

const controls: {
  churn: () => void;
  setOpen: (open: boolean) => void;
  setIds: (ids: string[]) => void;
} = { churn: () => {}, setOpen: () => {}, setIds: () => {} };

function Palette(props: { isOpen: boolean; ids: string[] }): ReactElement {
  // Fresh array every render — exactly what real palettes hand the kernel.
  const items: SpotlightItem[] = props.ids.map((id) => ({
    id,
    label: id,
    action: () => {},
  }));
  const kernel = useSelector({
    isOpen: props.isOpen,
    onClose: () => {},
    items,
  });
  return createElement("input", {
    ref: kernel.inputRef,
    "data-palette": "1",
  });
}

/** The session-creator page shape: a composer input + a mounted palette. */
function Harness(): ReactElement {
  const [, setChurn] = useState(0);
  const [isOpen, setOpen] = useState(false);
  const [ids, setIds] = useState(["alpha", "beta", "gamma"]);
  useEffect(() => {
    controls.churn = () => setChurn((value) => value + 1);
    controls.setOpen = setOpen;
    controls.setIds = setIds;
  }, []);
  return createElement(
    "div",
    null,
    createElement("input", { id: "composer" }),
    createElement(Palette, { isOpen, ids })
  );
}

describe("useSelector focus steal", () => {
  let root: SmokeRoot;
  let composer: HTMLInputElement;
  let paletteInput: HTMLInputElement;
  let focusSpy: MockInstance;

  beforeEach(async () => {
    vi.useFakeTimers();
    root = createSmokeRoot();
    await root.render(createElement(Harness));
    await settle();
    composer = root.container.querySelector("#composer") as HTMLInputElement;
    paletteInput = root.container.querySelector(
      "input[data-palette]"
    ) as HTMLInputElement;
    focusSpy = vi.spyOn(paletteInput, "focus");
  });

  afterEach(async () => {
    await root.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("a closed palette never steals focus, however often the parent renders", async () => {
    composer.focus();
    focusSpy.mockClear();
    for (let index = 0; index < 25; index += 1) {
      await dispatch(() => controls.churn());
    }
    await settle();
    expect(focusSpy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(composer);
  });

  it("an open palette focuses once, then ignores same-content array churn", async () => {
    await dispatch(() => controls.setOpen(true));
    await settle();
    // Sanity: opening must focus the palette input at all.
    expect(focusSpy).toHaveBeenCalled();

    focusSpy.mockClear();
    for (let index = 0; index < 25; index += 1) {
      await dispatch(() => controls.churn());
    }
    await settle();
    // Reference churn with identical item ids must not refocus (the effect
    // keys on content identity, not the array reference).
    expect(focusSpy).not.toHaveBeenCalled();
  });

  it("content changes while open still refocus (effect is alive)", async () => {
    await dispatch(() => controls.setOpen(true));
    await settle();
    focusSpy.mockClear();

    await dispatch(() => controls.setIds(["delta", "epsilon"]));
    await settle();
    expect(focusSpy).toHaveBeenCalled();
  });

  it("releases global list navigation when a tab's palette becomes inactive", async () => {
    const arrow = () => {
      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      document.body.dispatchEvent(event);
      return event.defaultPrevented;
    };
    expect(arrow()).toBe(false);
    await dispatch(() => controls.setOpen(true));
    await dispatch(() => expect(arrow()).toBe(true));
    await dispatch(() => controls.setOpen(false));
    expect(arrow()).toBe(false);
  });
});
