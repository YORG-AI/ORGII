// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const atomValues = { activeHost: "code", hasRealTabs: true };

vi.mock("jotai", async (importOriginal) => ({
  ...(await importOriginal<typeof import("jotai")>()),
  useAtomValue: (atom: unknown) => {
    const { activeHostAtom } = atomsModule;
    return atom === activeHostAtom
      ? atomValues.activeHost
      : atomValues.hasRealTabs;
  },
}));

const atomsModule = await import("@src/store/workstation");
const { HOST_KEEP_ALIVE_GRACE_MS, useAppShellDock } =
  await import("./useAppShellDock");

let latest: string[] = [];

function Harness() {
  const { visitedModes } = useAppShellDock();
  useEffect(() => {
    latest = [...visitedModes].sort();
  }, [visitedModes]);
  return null;
}

describe("useAppShellDock keep-alive window", () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (activeHost: string, hasRealTabs = true) => {
    atomValues.activeHost = activeHost;
    atomValues.hasRealTabs = hasRealTabs;
    act(() => {
      root.render(createElement(Harness));
    });
    return latest;
  };

  beforeEach(() => {
    vi.useFakeTimers();
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

  it("keeps a left host warm for the grace window, then releases it", () => {
    expect(render("code")).toEqual(["code"]);
    expect(render("browser")).toEqual(["browser", "code"]);

    act(() => {
      vi.advanceTimersByTime(HOST_KEEP_ALIVE_GRACE_MS - 1);
    });
    expect(latest).toEqual(["browser", "code"]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(latest).toEqual(["browser"]);
  });

  it("returning to a warm host cancels its release", () => {
    render("code");
    render("browser");
    act(() => {
      vi.advanceTimersByTime(HOST_KEEP_ALIVE_GRACE_MS / 2);
    });
    expect(render("code")).toEqual(["browser", "code"]);
    act(() => {
      vi.advanceTimersByTime(HOST_KEEP_ALIVE_GRACE_MS);
    });
    expect(latest).toEqual(["code"]);
  });

  it("releases everything at once when the real-tab pool empties", () => {
    render("code");
    render("project");
    expect(render("project", false)).toEqual([]);
  });
});
