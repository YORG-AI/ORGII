// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { BRANCH_REMOTE_MUTATION_EVENT } from "@src/util/git/branchRemoteMutation";

import { fetchRustApi } from "./client";
import { gitFetch, gitPush } from "./operations";

vi.mock("./client", () => ({
  fetchRustApi: vi.fn(),
  gitRepoUrl: (repoId: string) => `/git/repos/${repoId}`,
}));

const fetchRustApiMock = vi.mocked(fetchRustApi);

describe("gitPush", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("announces the pushed repo and branch after success", async () => {
    fetchRustApiMock.mockResolvedValue({ data: { success: true } } as never);
    const details: unknown[] = [];
    const listener = (event: Event) => {
      details.push((event as CustomEvent).detail);
    };
    window.addEventListener(BRANCH_REMOTE_MUTATION_EVENT, listener);

    try {
      await gitPush({
        repo_id: "repo-1",
        repo_path: "/repo",
        branch: "feature",
      });
    } finally {
      window.removeEventListener(BRANCH_REMOTE_MUTATION_EVENT, listener);
    }

    expect(details).toEqual([
      {
        repoId: "repo-1",
        repoPath: "/repo",
        branchName: "feature",
        reason: "push",
      },
    ]);
  });
});

describe("gitFetch", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  // Regression: the wire body used to default `prune: true` when the caller
  // passed nothing, silently deleting local remote-tracking refs on every
  // plain fetch — and the layer above asserted "prune only when requested"
  // against its own payload, never the wire body.
  it("sends prune only when the caller explicitly asked for it", async () => {
    fetchRustApiMock.mockResolvedValue({ data: { success: true } } as never);

    await gitFetch({ repo_id: "repo-1", repo_path: "/repo" });
    const bodyWithout = JSON.parse(
      (fetchRustApiMock.mock.calls[0][1] as RequestInit).body as string
    );
    expect(bodyWithout.prune).toBe(false);

    await gitFetch({ repo_id: "repo-1", repo_path: "/repo", prune: true });
    const bodyWith = JSON.parse(
      (fetchRustApiMock.mock.calls[1][1] as RequestInit).body as string
    );
    expect(bodyWith.prune).toBe(true);
  });
});
