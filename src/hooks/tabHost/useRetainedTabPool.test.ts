// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { type Root, createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RETENTION_POOLS } from "@src/store/workstation/tabs/tabRetention";
import type { WorkStationTab } from "@src/store/workstation/tabs/types";

import { useRetainedTabPool } from "./useRetainedTabPool";

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function tab(id: string, type: WorkStationTab["type"]): WorkStationTab {
  return { id, type, title: id, data: {} };
}

const REVIEW = tab("source-control:changes", "source-control");
const FILE = tab("file:a.ts", "file");
const WORK_ITEMS = tab("project-workitems:1", "project-workitems");
const LINEAR = tab("project-linear-projects:1", "project-linear-projects");
const LINEAR_ITEMS = tab(
  "project-linear-work-items:1",
  "project-linear-work-items"
);

interface HarnessProps {
  poolId: "source-control" | "project-trio";
  tabs: WorkStationTab[];
  activeTabId: string | null;
  onResult: (ids: string[]) => void;
}

function Harness({ poolId, tabs, activeTabId, onResult }: HarnessProps) {
  const retained = useRetainedTabPool(poolId, tabs, activeTabId);
  useEffect(() => {
    onResult([...retained].sort());
  }, [onResult, retained]);
  return null;
}

describe("useRetainedTabPool", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: string[] = [];
  const onResult = (ids: string[]) => {
    latest = ids;
  };

  const render = (props: Omit<HarnessProps, "onResult">) => {
    act(() => {
      root.render(createElement(Harness, { ...props, onResult }));
    });
    return latest;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    latest = [];
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps the Review tab mounted after leaving it, until its grace runs out", () => {
    const tabs = [REVIEW, FILE];
    expect(
      render({ poolId: "source-control", tabs, activeTabId: REVIEW.id })
    ).toEqual([REVIEW.id]);

    // Switch to a file tab: Review stays warm (hidden, not rebuilt).
    expect(
      render({ poolId: "source-control", tabs, activeTabId: FILE.id })
    ).toEqual([REVIEW.id]);

    // Come back within the window: still the same mounted instance.
    expect(
      render({ poolId: "source-control", tabs, activeTabId: REVIEW.id })
    ).toEqual([REVIEW.id]);

    // Leave and stay away past the grace: released.
    render({ poolId: "source-control", tabs, activeTabId: FILE.id });
    act(() => {
      vi.advanceTimersByTime(RETENTION_POOLS["source-control"].graceMs);
    });
    expect(latest).toEqual([]);
  });

  it("never includes tabs of types outside the pool", () => {
    const tabs = [REVIEW, FILE, WORK_ITEMS];
    expect(
      render({ poolId: "source-control", tabs, activeTabId: FILE.id })
    ).toEqual([]);
    expect(
      render({ poolId: "source-control", tabs, activeTabId: WORK_ITEMS.id })
    ).toEqual([]);
  });

  it("caps the project trio at its warm limit, evicting the oldest", () => {
    const tabs = [WORK_ITEMS, LINEAR, LINEAR_ITEMS];
    render({ poolId: "project-trio", tabs, activeTabId: WORK_ITEMS.id });
    render({ poolId: "project-trio", tabs, activeTabId: LINEAR.id });
    expect(
      render({ poolId: "project-trio", tabs, activeTabId: LINEAR_ITEMS.id })
    ).toEqual([LINEAR.id, LINEAR_ITEMS.id].sort());
    expect(latest.length).toBe(RETENTION_POOLS["project-trio"].maxWarm);
  });

  it("drops a retained tab the moment it is closed", () => {
    render({
      poolId: "source-control",
      tabs: [REVIEW, FILE],
      activeTabId: REVIEW.id,
    });
    render({
      poolId: "source-control",
      tabs: [REVIEW, FILE],
      activeTabId: FILE.id,
    });
    expect(latest).toEqual([REVIEW.id]);
    expect(
      render({ poolId: "source-control", tabs: [FILE], activeTabId: FILE.id })
    ).toEqual([]);
  });
});
