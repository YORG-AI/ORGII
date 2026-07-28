import { describe, expect, it, vi } from "vitest";

import type { EnrichedWorkItem, ProjectData } from "@src/api/http/project";

import {
  createAsyncGenerationGuard,
  loadWorkItemLinkOptions,
} from "./linkSessionToWorkItemModel";

const project = (slug: string) =>
  ({ slug, meta: { name: slug } }) as ProjectData;
const item = (shortId: string) => ({ shortId }) as EnrichedWorkItem;

describe("link session work-item loading lifecycle", () => {
  it("rejects stale generations after close or unmount", () => {
    const guard = createAsyncGenerationGuard();
    const generation = guard.begin();
    expect(guard.isCurrent(generation)).toBe(true);

    guard.invalidate();
    expect(guard.isCurrent(generation)).toBe(false);
  });

  it("preserves project order while loading with bounded concurrency", async () => {
    const readWorkItems = vi.fn(async (slug: string) => [item(`${slug}-1`)]);

    const result = await loadWorkItemLinkOptions(
      [project("a"), project("b"), project("c")],
      readWorkItems,
      () => true,
      2
    );

    expect(readWorkItems).toHaveBeenCalledTimes(3);
    expect(result?.map((option) => option.project.slug)).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("does not start more reads after the view is closed", async () => {
    let current = true;
    let releaseFirstReads: (() => void) | undefined;
    const firstReads = new Promise<void>((resolve) => {
      releaseFirstReads = resolve;
    });
    const readWorkItems = vi.fn(async () => {
      await firstReads;
      return [item("WI-1")];
    });

    const loading = loadWorkItemLinkOptions(
      [project("a"), project("b"), project("c"), project("d")],
      readWorkItems,
      () => current,
      2
    );
    await Promise.resolve();
    expect(readWorkItems).toHaveBeenCalledTimes(2);

    current = false;
    releaseFirstReads?.();

    await expect(loading).resolves.toBeNull();
    expect(readWorkItems).toHaveBeenCalledTimes(2);
  });
});
