import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  invalidateProjectDataChangeCaches,
  parseProjectDataChange,
} from "./useProjectDataChanged";

const mocks = vi.hoisted(() => ({
  invalidateProjectCache: vi.fn(),
}));

vi.mock("@src/api/http/project", () => ({
  invalidateProjectCache: mocks.invalidateProjectCache,
}));

describe("project data-change scoping", () => {
  beforeEach(() => vi.clearAllMocks());

  it("normalizes scoped wire payloads", () => {
    expect(
      parseProjectDataChange({
        project_slug: "demo",
        work_item_id: "DEM-7",
        repo_path: "/repos/demo",
        source: "test",
      })
    ).toEqual({
      projectSlug: "demo",
      workItemId: "DEM-7",
      repoPath: "/repos/demo",
      source: "test",
    });
    expect(parseProjectDataChange("legacy-payload")).toBeNull();
  });

  it("invalidates only the project and project summaries when scoped", () => {
    invalidateProjectDataChangeCaches({
      projectSlug: "demo",
      workItemId: "DEM-7",
    });

    expect(mocks.invalidateProjectCache.mock.calls).toEqual([
      ["demo"],
      ["__projects__"],
    ]);
  });

  it("flushes safely for repo-path-only and legacy events", () => {
    invalidateProjectDataChangeCaches({ repoPath: "/repos/demo" });
    invalidateProjectDataChangeCaches(null);

    expect(mocks.invalidateProjectCache.mock.calls).toEqual([[], []]);
  });
});
