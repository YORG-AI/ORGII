import { createStore } from "jotai";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitHubIssue } from "@src/api/tauri/github";

import {
  getGitHubIssueDetailCoordinatorStats,
  loadGitHubDuplicateCandidates,
  loadGitHubIssueDetailBundle,
  resetGitHubIssueDetailCoordinator,
} from "./githubIssueDetailCoordinator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

function bundle(number: number) {
  return {
    issue: { number } as GitHubIssue,
    timeline: [],
    error: null,
  };
}

describe("githubIssueDetailCoordinator", () => {
  beforeEach(() => resetGitHubIssueDetailCoordinator());

  it("single-flights equal requests within one store", async () => {
    const store = createStore();
    const pending = deferred<ReturnType<typeof bundle>>();
    const loader = vi.fn(() => pending.promise);

    const first = loadGitHubIssueDetailBundle(store, "auth|org/repo#1", loader);
    const second = loadGitHubIssueDetailBundle(
      store,
      "auth|org/repo#1",
      loader
    );

    expect(first).toBe(second);
    expect(loader).toHaveBeenCalledOnce();
    pending.resolve(bundle(1));
    await expect(first).resolves.toEqual(bundle(1));
  });

  it("isolates stores and bounds retained issue snapshots", async () => {
    const firstStore = createStore();
    const secondStore = createStore();
    const loader = vi.fn(async () => bundle(1));

    await Promise.all([
      loadGitHubIssueDetailBundle(firstStore, "auth|org/repo#1", loader),
      loadGitHubIssueDetailBundle(secondStore, "auth|org/repo#1", loader),
    ]);
    expect(loader).toHaveBeenCalledTimes(2);

    for (let number = 2; number <= 40; number += 1) {
      await loadGitHubIssueDetailBundle(
        firstStore,
        `auth|org/repo#${number}`,
        async () => bundle(number)
      );
    }

    expect(
      getGitHubIssueDetailCoordinatorStats(firstStore).issueDetails
    ).toMatchObject({ entries: 24, maxEntries: 24, inFlight: 0 });
    expect(
      getGitHubIssueDetailCoordinatorStats(secondStore).issueDetails.entries
    ).toBe(1);
  });

  it("does not retain failed detail responses", async () => {
    const store = createStore();
    const loader = vi.fn(async () => ({
      issue: null,
      timeline: [],
      error: "offline",
    }));

    await loadGitHubIssueDetailBundle(store, "auth|org/repo#1", loader);
    await loadGitHubIssueDetailBundle(store, "auth|org/repo#1", loader);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(
      getGitHubIssueDetailCoordinatorStats(store).issueDetails.entries
    ).toBe(0);
  });

  it("keeps duplicate-candidate results scoped to the current issue", async () => {
    const store = createStore();
    const loader = vi.fn(async () => []);

    await loadGitHubDuplicateCandidates(store, "auth", "org/repo", 1, loader);
    await loadGitHubDuplicateCandidates(store, "auth", "org/repo", 2, loader);

    expect(loader).toHaveBeenCalledTimes(2);
  });
});
