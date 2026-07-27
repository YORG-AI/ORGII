import { beforeEach, describe, expect, it, vi } from "vitest";

import { __TESTS_ONLY, deleteRepo, getRepos } from "@src/api/tauri/repo";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

function backendRepo(id: string) {
  return {
    id,
    repo_id: id,
    name: id,
    path: `/repos/${id}`,
  };
}

describe("repository list coordinator", () => {
  beforeEach(() => {
    __TESTS_ONLY.resetRepoListCoordinator();
    invokeMock.mockReset();
  });

  it("shares one list request between concurrent consumers", async () => {
    invokeMock.mockResolvedValue([backendRepo("one")]);

    const [first, second] = await Promise.all([getRepos(), getRepos()]);

    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });

  it("runs one trailing request when force refresh arrives in flight", async () => {
    let releaseFirst!: (repos: ReturnType<typeof backendRepo>[]) => void;
    invokeMock
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = resolve;
          })
      )
      .mockResolvedValueOnce([backendRepo("fresh")]);

    const initial = getRepos();
    const forced = getRepos({ forceRefresh: true });
    releaseFirst([backendRepo("stale")]);

    const [initialResult, forcedResult] = await Promise.all([initial, forced]);

    expect(invokeMock).toHaveBeenCalledTimes(2);
    expect(initialResult.data.repos[0]?.repo_id).toBe("fresh");
    expect(forcedResult.data.repos[0]?.repo_id).toBe("fresh");
  });

  it("refreshes an active list after a repository mutation", async () => {
    let releaseFirst!: (repos: ReturnType<typeof backendRepo>[]) => void;
    invokeMock.mockImplementation((command: string) => {
      if (command === "server_delete_repo") return Promise.resolve(true);
      if (
        invokeMock.mock.calls.filter(([name]) => name === "server_list_repos")
          .length === 1
      ) {
        return new Promise((resolve) => {
          releaseFirst = resolve;
        });
      }
      return Promise.resolve([backendRepo("remaining")]);
    });

    const listing = getRepos();
    await deleteRepo("removed");
    releaseFirst([backendRepo("removed"), backendRepo("remaining")]);
    const result = await listing;

    expect(
      invokeMock.mock.calls.filter(([name]) => name === "server_list_repos")
    ).toHaveLength(2);
    expect(result.data.repos.map((repo) => repo.repo_id)).toEqual([
      "remaining",
    ]);
  });

  it("releases a failed list request so a later load can retry", async () => {
    invokeMock
      .mockRejectedValueOnce(new Error("backend unavailable"))
      .mockResolvedValueOnce([backendRepo("recovered")]);

    await expect(getRepos()).rejects.toThrow("backend unavailable");
    await expect(getRepos()).resolves.toMatchObject({
      data: { repos: [{ repo_id: "recovered" }] },
    });

    expect(invokeMock).toHaveBeenCalledTimes(2);
  });
});
