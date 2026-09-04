import { beforeEach, describe, expect, it, vi } from "vitest";

import { applyWorkItemUpdate } from "./workItemSource";

const mocks = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("@src/api/http/project", () => ({
  projectApi: { updateWorkItemPartial: mocks.update },
}));

describe("applyWorkItemUpdate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the persisted patch and actor using the caller's exact identity", async () => {
    const persisted = { id: "canonical-id", title: "Persisted title" };
    mocks.update.mockResolvedValue(persisted);

    await expect(
      applyWorkItemUpdate(
        "project-slug",
        "PREFIX-7",
        { name: "New title", workItemStatus: "in_progress", labels: [] },
        { id: " member-1 ", name: " Ada " }
      )
    ).resolves.toBe(persisted);

    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith("project-slug", "PREFIX-7", {
      title: "New title",
      status: "in_progress",
      labels: [],
      actor: { id: "member-1", name: "Ada" },
    });
  });

  it("does not issue a write for an empty persisted edit, even with an actor", async () => {
    await expect(
      applyWorkItemUpdate(
        "project-slug",
        "item-id",
        {},
        { id: "a", name: "Ada" }
      )
    ).resolves.toBeNull();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("leaves failure handling to the host without issuing a second request", async () => {
    const failure = new Error("permission denied");
    mocks.update.mockRejectedValue(failure);
    await expect(
      applyWorkItemUpdate("project-slug", "canonical-id", { star: true })
    ).rejects.toBe(failure);
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith("project-slug", "canonical-id", {
      starred: true,
    });
  });
});
