import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import {
  beginSessionHydrationAtom,
  endSessionHydrationAtom,
  sessionHydrationCountMapAtom,
} from "../metadata";

describe("session hydration state", () => {
  it("counts concurrent loads and evicts the session when the last load ends", () => {
    const store = createStore();

    store.set(beginSessionHydrationAtom, "imported-session-1");
    store.set(beginSessionHydrationAtom, "imported-session-1");
    expect(store.get(sessionHydrationCountMapAtom)).toEqual(
      new Map([["imported-session-1", { count: 2, iconId: undefined }]])
    );

    store.set(endSessionHydrationAtom, "imported-session-1");
    expect(
      store.get(sessionHydrationCountMapAtom).get("imported-session-1")
    ).toEqual({ count: 1, iconId: undefined });

    store.set(endSessionHydrationAtom, "imported-session-1");
    expect(store.get(sessionHydrationCountMapAtom).size).toBe(0);
  });

  it("ignores unmatched cleanup without retaining an entry", () => {
    const store = createStore();
    store.set(endSessionHydrationAtom, "imported-session-missing");
    expect(store.get(sessionHydrationCountMapAtom).size).toBe(0);
  });

  it("retains the pending icon hint across concurrent loads", () => {
    const store = createStore();
    store.set(beginSessionHydrationAtom, {
      sessionId: "imported-session-1",
      iconId: "codex",
    });
    store.set(beginSessionHydrationAtom, "imported-session-1");

    expect(
      store.get(sessionHydrationCountMapAtom).get("imported-session-1")
    ).toEqual({ count: 2, iconId: "codex" });
  });
});
