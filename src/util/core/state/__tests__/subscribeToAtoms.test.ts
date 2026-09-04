import { atom, createStore } from "jotai";
import { describe, expect, it, vi } from "vitest";

import { subscribeToAtoms } from "../subscribeToAtoms";

describe("subscribeToAtoms", () => {
  it("invokes listener when any subscribed atom changes", () => {
    const store = createStore();
    const countAtom = atom(0);
    const labelAtom = atom("idle");
    const listener = vi.fn();

    subscribeToAtoms(store, [countAtom, labelAtom], listener);
    listener.mockClear();

    store.set(countAtom, 1);
    expect(listener).toHaveBeenCalledTimes(1);

    store.set(labelAtom, "busy");
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying after the returned disposer runs", () => {
    const store = createStore();
    const countAtom = atom(0);
    const labelAtom = atom("idle");
    const listener = vi.fn();

    const unsubscribe = subscribeToAtoms(
      store,
      [countAtom, labelAtom],
      listener
    );
    listener.mockClear();

    unsubscribe();
    store.set(countAtom, 1);
    store.set(labelAtom, "busy");

    expect(listener).not.toHaveBeenCalled();
  });

  it("returns a no-op disposer for an empty atom list", () => {
    const store = createStore();
    const listener = vi.fn();

    const unsubscribe = subscribeToAtoms(store, [], listener);

    expect(() => unsubscribe()).not.toThrow();
    expect(listener).not.toHaveBeenCalled();
  });
});
