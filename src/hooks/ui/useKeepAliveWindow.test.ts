// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useKeepAliveWindow } from "./useKeepAliveWindow";

interface HarnessProps {
  activeKey: string | null;
  presentKeys: string[];
  graceMs: number;
  maxWarm?: number;
}

let latest: ReadonlySet<string> = new Set();

function Harness({ activeKey, presentKeys, graceMs, maxWarm }: HarnessProps) {
  const warm = useKeepAliveWindow(activeKey, presentKeys, {
    graceMs,
    maxWarm,
    now: () => Date.now(),
  });
  // Publish the latest result from an effect (not during render) so the
  // harness stays a valid component under the react-hooks lint rules.
  useEffect(() => {
    latest = warm;
  }, [warm]);
  return null;
}

describe("useKeepAliveWindow", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (props: HarnessProps) => {
    act(() => {
      root.render(createElement(Harness, props));
    });
    return [...latest].sort();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T00:00:00Z"));
    (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it("keeps the active key and keeps a deactivated key warm for the grace window", () => {
    const keys = ["a", "b", "c"];
    expect(
      render({ activeKey: "a", presentKeys: keys, graceMs: 1000 })
    ).toEqual(["a"]);
    expect(
      render({ activeKey: "b", presentKeys: keys, graceMs: 1000 })
    ).toEqual(["a", "b"]);

    act(() => {
      vi.advanceTimersByTime(999);
    });
    expect([...latest].sort()).toEqual(["a", "b"]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect([...latest].sort()).toEqual(["b"]);
  });

  it("re-activating a warm key cancels its expiry", () => {
    const keys = ["a", "b"];
    render({ activeKey: "a", presentKeys: keys, graceMs: 1000 });
    render({ activeKey: "b", presentKeys: keys, graceMs: 1000 });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(
      render({ activeKey: "a", presentKeys: keys, graceMs: 1000 })
    ).toEqual(["a", "b"]);
    act(() => {
      vi.advanceTimersByTime(600);
    });
    // "a" is active again; "b" was deactivated at t=500 and expires at t=1500.
    expect([...latest].sort()).toEqual(["a", "b"]);
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect([...latest].sort()).toEqual(["a"]);
  });

  it("bounds the warm set to maxWarm, dropping the least recently deactivated first", () => {
    const keys = ["a", "b", "c", "d"];
    const opts = { presentKeys: keys, graceMs: 60_000, maxWarm: 2 };
    render({ activeKey: "a", ...opts });
    render({ activeKey: "b", ...opts });
    expect(render({ activeKey: "c", ...opts })).toEqual(["b", "c"]);
    expect(render({ activeKey: "d", ...opts })).toEqual(["c", "d"]);
  });

  it("drops keys that are no longer present, and never returns an absent active key", () => {
    render({ activeKey: "a", presentKeys: ["a", "b"], graceMs: 60_000 });
    render({ activeKey: "b", presentKeys: ["a", "b"], graceMs: 60_000 });
    expect(
      render({ activeKey: "b", presentKeys: ["b"], graceMs: 60_000 })
    ).toEqual(["b"]);
    expect(
      render({ activeKey: null, presentKeys: [], graceMs: 60_000 })
    ).toEqual([]);
  });
});
