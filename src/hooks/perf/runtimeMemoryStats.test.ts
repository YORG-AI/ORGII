import { afterEach, describe, expect, it } from "vitest";

import {
  getChatRenderedTreeMemoryStats,
  getLoadedScriptSourceStats,
  registerChatRenderedTreeMemoryEntry,
} from "./runtimeMemoryStats";

describe("chat rendered-tree memory diagnostics", () => {
  let unregister: (() => void) | null = null;

  afterEach(() => {
    unregister?.();
    unregister = null;
  });

  it("reads and normalizes the latest entry only when statistics are requested", () => {
    let reads = 0;
    let current = { bytes: 10.4, items: 2.6, label: "session-1" };
    unregister = registerChatRenderedTreeMemoryEntry(Symbol("test"), () => {
      reads += 1;
      return current;
    });

    expect(reads).toBe(0);
    expect(getChatRenderedTreeMemoryStats()).toEqual({
      bytes: 10,
      entries: 1,
      items: 3,
      topEntries: [{ bytes: 10, items: 3, label: "session-1" }],
    });
    expect(reads).toBe(1);

    current = { bytes: 25.8, items: 4.2, label: "session-2" };
    expect(getChatRenderedTreeMemoryStats()).toEqual({
      bytes: 26,
      entries: 1,
      items: 4,
      topEntries: [{ bytes: 26, items: 4, label: "session-2" }],
    });
    expect(reads).toBe(2);

    unregister();
    unregister = null;
    expect(getChatRenderedTreeMemoryStats()).toEqual({
      bytes: 0,
      entries: 0,
      items: 0,
      topEntries: [],
    });
  });
});

describe("getLoadedScriptSourceStats", () => {
  it("sums module factory source text across every chunk registry", () => {
    const factoryA = function moduleA() {
      return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    };
    const factoryB = () => 1;
    const fakeGlobal = {
      rspackChunkorgii: [
        [["main"], { "./a.js": factoryA }],
        [["src_App_tsx"], { "./b.js": factoryB, "./not-a-module": "x" }],
      ],
      webpackChunkother: [[["x"], {}]],
      unrelated: [[["y"], { "./c.js": factoryB }]],
    };

    expect(getLoadedScriptSourceStats(fakeGlobal)).toEqual({
      chunks: 3,
      modules: 2,
      sourceBytes:
        Function.prototype.toString.call(factoryA).length +
        Function.prototype.toString.call(factoryB).length,
    });
  });

  it("returns zeros when no chunk registry exists", () => {
    expect(getLoadedScriptSourceStats({ foo: 1 })).toEqual({
      chunks: 0,
      modules: 0,
      sourceBytes: 0,
    });
  });
});
