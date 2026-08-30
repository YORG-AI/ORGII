import { createStore } from "jotai";
import { describe, expect, it } from "vitest";

import { terminalSessionsAtom } from "@src/store/workstation/codeEditor/terminal";

import {
  closeMiniTerminalAtom,
  miniTerminalActiveIdAtom,
  miniTerminalClaimedIdsAtom,
  miniTerminalHostMountedAtom,
  miniTerminalSuppressedIdsAtom,
  miniTerminalVisibleAtom,
  openMiniTerminalAtom,
  releaseMiniTerminalSessionAtom,
  setMiniTerminalActiveIdAtom,
} from "../miniTerminalAtom";

function seedStore(sessionIds: string[]) {
  const store = createStore();
  store.set(
    terminalSessionsAtom,
    sessionIds.map((id) => ({ id, name: id, isActive: false }))
  );
  // The trail registers itself as the panel's host on mount.
  store.set(miniTerminalHostMountedAtom, true);
  return store;
}

describe("mini terminal claims", () => {
  it("claims a session and suppresses it in the Workstation pane", () => {
    const store = seedStore(["a", "b"]);
    store.set(openMiniTerminalAtom, "a");

    expect(store.get(miniTerminalVisibleAtom)).toBe(true);
    expect(store.get(miniTerminalClaimedIdsAtom)).toEqual(["a"]);
    expect([...store.get(miniTerminalSuppressedIdsAtom)]).toEqual(["a"]);
    expect(store.get(miniTerminalActiveIdAtom)).toBe("a");
  });

  it("re-opening an already claimed session only refocuses it", () => {
    const store = seedStore(["a", "b"]);
    store.set(openMiniTerminalAtom, "a");
    store.set(openMiniTerminalAtom, "b");
    store.set(openMiniTerminalAtom, "a");

    expect(store.get(miniTerminalClaimedIdsAtom)).toEqual(["a", "b"]);
    expect(store.get(miniTerminalActiveIdAtom)).toBe("a");
  });

  it("suppresses nothing while the panel is hidden", () => {
    const store = seedStore(["a"]);
    store.set(openMiniTerminalAtom, "a");
    store.set(miniTerminalVisibleAtom, false);

    // The Workstation pane must remount a session the panel is not showing,
    // otherwise a hidden panel would strand the PTY with no xterm at all.
    expect(store.get(miniTerminalSuppressedIdsAtom).size).toBe(0);
  });

  it("suppresses nothing while the trail that hosts the panel is unmounted", () => {
    const store = seedStore(["a"]);
    store.set(openMiniTerminalAtom, "a");
    store.set(miniTerminalHostMountedAtom, false);

    expect(store.get(miniTerminalVisibleAtom)).toBe(true);
    expect(store.get(miniTerminalSuppressedIdsAtom).size).toBe(0);
  });

  it("prunes a claim whose PTY was closed elsewhere", () => {
    const store = seedStore(["a", "b"]);
    store.set(openMiniTerminalAtom, "a");
    store.set(openMiniTerminalAtom, "b");
    store.set(terminalSessionsAtom, [{ id: "b", name: "b", isActive: false }]);

    expect(store.get(miniTerminalClaimedIdsAtom)).toEqual(["b"]);
    expect(store.get(miniTerminalActiveIdAtom)).toBe("b");
  });

  it("moves the active tab off a released session", () => {
    const store = seedStore(["a", "b"]);
    store.set(openMiniTerminalAtom, "a");
    store.set(openMiniTerminalAtom, "b");
    store.set(setMiniTerminalActiveIdAtom, "a");
    store.set(releaseMiniTerminalSessionAtom, "a");

    expect(store.get(miniTerminalClaimedIdsAtom)).toEqual(["b"]);
    expect(store.get(miniTerminalActiveIdAtom)).toBe("b");
    expect(store.get(miniTerminalVisibleAtom)).toBe(true);
  });

  it("hides the panel once its last claim is released", () => {
    const store = seedStore(["a"]);
    store.set(openMiniTerminalAtom, "a");
    store.set(releaseMiniTerminalSessionAtom, "a");

    expect(store.get(miniTerminalVisibleAtom)).toBe(false);
    expect(store.get(miniTerminalClaimedIdsAtom)).toEqual([]);
  });

  it("releases every claim when the panel closes", () => {
    const store = seedStore(["a", "b"]);
    store.set(openMiniTerminalAtom, "a");
    store.set(openMiniTerminalAtom, "b");
    store.set(closeMiniTerminalAtom);

    expect(store.get(miniTerminalVisibleAtom)).toBe(false);
    expect(store.get(miniTerminalSuppressedIdsAtom).size).toBe(0);
  });
});
