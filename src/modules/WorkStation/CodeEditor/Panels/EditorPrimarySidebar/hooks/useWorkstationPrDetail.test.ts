// @vitest-environment jsdom
import { Provider, useAtomValue } from "jotai";
import { createStore } from "jotai/vanilla";
import React, { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  getCachedPrDetail,
  prDetailKey,
} from "@src/services/git/githubListCache";
import {
  type PrIdentity,
  workstationPrDetailCallbackAtomFamily,
  workstationPrScopeKey,
  workstationSelectedPrAtomFamily,
} from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import { useWorkstationPrDetail } from "./useWorkstationPrDetail";

/** A promise plus its resolve/reject, for controlling settle timing in tests. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const apiMocks = vi.hoisted(() => ({
  createIssueCommentLocal: vi.fn(),
  createPrReviewCommentLocal: vi.fn(),
  createPrReviewLocal: vi.fn(),
  getChecksLocal: vi.fn(),
  getGitRemotes: vi.fn(),
  getPRLocal: vi.fn(),
  listIssueCommentsLocal: vi.fn(),
  listPRCommitsLocal: vi.fn(),
  listPRFilesLocal: vi.fn(),
  listPrReviewCommentsLocal: vi.fn(),
  listPrReviewsLocal: vi.fn(),
  listRepoAssigneesLocal: vi.fn(),
  mergePRLocal: vi.fn(),
  removePRReviewersLocal: vi.fn(),
  requestPRReviewersLocal: vi.fn(),
  replyPrReviewCommentLocal: vi.fn(),
  setPRAutoMergeLocal: vi.fn(),
  updatePRDraftStateLocal: vi.fn(),
  updatePRStateLocal: vi.fn(),
}));

vi.mock("@src/api/http/git/remotes", () => ({
  getGitRemotes: apiMocks.getGitRemotes,
}));

vi.mock("@src/api/tauri/github", () => ({
  createIssueCommentLocal: apiMocks.createIssueCommentLocal,
  createPrReviewCommentLocal: apiMocks.createPrReviewCommentLocal,
  createPrReviewLocal: apiMocks.createPrReviewLocal,
  getChecksLocal: apiMocks.getChecksLocal,
  getPRLocal: apiMocks.getPRLocal,
  listIssueCommentsLocal: apiMocks.listIssueCommentsLocal,
  listPRCommitsLocal: apiMocks.listPRCommitsLocal,
  listPRFilesLocal: apiMocks.listPRFilesLocal,
  listPrReviewCommentsLocal: apiMocks.listPrReviewCommentsLocal,
  listPrReviewsLocal: apiMocks.listPrReviewsLocal,
  listRepoAssigneesLocal: apiMocks.listRepoAssigneesLocal,
  mergePRLocal: apiMocks.mergePRLocal,
  removePRReviewersLocal: apiMocks.removePRReviewersLocal,
  requestPRReviewersLocal: apiMocks.requestPRReviewersLocal,
  replyPrReviewCommentLocal: apiMocks.replyPrReviewCommentLocal,
  setPRAutoMergeLocal: apiMocks.setPRAutoMergeLocal,
  updatePRDraftStateLocal: apiMocks.updatePRDraftStateLocal,
  updatePRStateLocal: apiMocks.updatePRStateLocal,
}));

const REPO_PATH = "C:\\repo";
const REPO_ID = "repo-cache-regression";
const PR_NUMBER = 910_042;
const PR = {
  number: PR_NUMBER,
  title: "Cache regression",
  url: `https://github.com/org/repo/pull/${PR_NUMBER}`,
  status: "open",
  headBranch: "fix/cache",
  baseBranch: "develop",
};
const COMMENT = {
  id: 42,
  body: "orgii://cloud/session/ref?v=1",
  user: { login: "reviewer", avatar_url: "" },
  created_at: "2026-07-28T18:09:00.000Z",
  updated_at: "2026-07-28T18:09:00.000Z",
  html_url: `${PR.url}#issuecomment-42`,
};
const SCOPE_KEY = workstationPrScopeKey(REPO_ID, REPO_PATH, PR_NUMBER);
/** Matches the "origin" remote mocked in `beforeEach` below. */
const REPO_FULL_NAME = "org/repo";
type Store = ReturnType<typeof createStore>;

interface HarnessProps {
  pr?: PrIdentity;
}

const Harness: React.FC<HarnessProps> = ({ pr = PR }) => {
  useWorkstationPrDetail({
    repoPath: REPO_PATH,
    repoId: REPO_ID,
    pr,
  });
  const scopeKey = workstationPrScopeKey(REPO_ID, REPO_PATH, pr.number);
  const state = useAtomValue(workstationSelectedPrAtomFamily(scopeKey));
  return React.createElement(
    "div",
    { "data-testid": "conversation" },
    state.conversation.map((comment) => comment.body).join("\n")
  );
};

async function waitForStore(
  store: Store,
  predicate: () => boolean
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    if (predicate()) return;
  }
  throw new Error(
    `Timed out waiting for PR state: ${JSON.stringify(
      store.get(workstationSelectedPrAtomFamily(SCOPE_KEY))
    )}`
  );
}

describe("useWorkstationPrDetail cache mutations", () => {
  let container: HTMLDivElement;
  let root: Root | null;
  let store: Store;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getGitRemotes.mockResolvedValue({
      remotes: [{ name: "origin", url: "https://github.com/org/repo.git" }],
    });
    apiMocks.getPRLocal.mockResolvedValue({
      head: { sha: null },
      base: { ref: "develop" },
    });
    apiMocks.listIssueCommentsLocal.mockResolvedValue([]);
    apiMocks.listPrReviewsLocal.mockResolvedValue([]);
    apiMocks.listPrReviewCommentsLocal.mockResolvedValue([]);
    apiMocks.listPRCommitsLocal.mockResolvedValue([]);
    apiMocks.listPRFilesLocal.mockResolvedValue([]);
    apiMocks.listRepoAssigneesLocal.mockResolvedValue([]);
    apiMocks.createIssueCommentLocal.mockResolvedValue(COMMENT);
    apiMocks.mergePRLocal.mockResolvedValue({
      sha: "merged-sha",
      merged: true,
      message: "merged",
    });
    apiMocks.setPRAutoMergeLocal.mockResolvedValue({ enabled: true });
    apiMocks.updatePRDraftStateLocal.mockResolvedValue(undefined);
    apiMocks.updatePRStateLocal.mockResolvedValue({});
    apiMocks.requestPRReviewersLocal.mockResolvedValue([]);
    apiMocks.removePRReviewersLocal.mockResolvedValue([]);
    // Only invoked when a bundle's headSha is truthy — most tests here use
    // the null-headSha default and never touch this, but any test opting
    // into a real headSha needs it to resolve (a bare `vi.fn()` returns
    // `undefined`, and `fetchPrDetailBundle` immediately calls `.catch()`
    // on the result).
    apiMocks.getChecksLocal.mockResolvedValue(null);

    store = createStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("keeps a posted comment after the PR panel unmounts and reopens", async () => {
    await act(async () => {
      root?.render(
        React.createElement(Provider, { store }, React.createElement(Harness))
      );
    });
    await waitForStore(
      store,
      () =>
        store.get(workstationSelectedPrAtomFamily(SCOPE_KEY)).loading === false
    );
    await waitForStore(
      store,
      () =>
        store.get(workstationPrDetailCallbackAtomFamily(SCOPE_KEY))
          .addComment !== null
    );

    // The post-mutation reconciliation this fix adds means a successful
    // `addComment` now issues a second `listIssueCommentsLocal` call — mimic
    // GitHub's read-after-write consistency by having it reflect the new
    // comment too.
    apiMocks.listIssueCommentsLocal.mockResolvedValueOnce([COMMENT]);

    await act(async () => {
      await store
        .get(workstationPrDetailCallbackAtomFamily(SCOPE_KEY))
        .addComment?.(COMMENT.body);
    });
    expect(
      store.get(workstationSelectedPrAtomFamily(SCOPE_KEY)).conversation
    ).toEqual([COMMENT]);
    act(() => {
      store.set(workstationSelectedPrAtomFamily(SCOPE_KEY), (current) => ({
        ...current,
        viewState: {
          ...current.viewState,
          activeTab: "commits",
          conversationDraft: "Preserve this draft",
          selectedCommitSha: "abc1234",
        },
      }));
    });
    // Wait for the background reconciliation to actually land before
    // unmounting, so its cache write isn't racing the remount below.
    await waitForStore(
      store,
      () => apiMocks.listIssueCommentsLocal.mock.calls.length >= 2
    );

    act(() => root?.unmount());
    root = createRoot(container);
    await act(async () => {
      root?.render(
        React.createElement(Provider, { store }, React.createElement(Harness))
      );
    });
    await waitForStore(
      store,
      () =>
        store.get(workstationSelectedPrAtomFamily(SCOPE_KEY)).conversation
          .length === 1
    );

    expect(
      store.get(workstationSelectedPrAtomFamily(SCOPE_KEY)).conversation
    ).toEqual([COMMENT]);
    expect(
      store.get(workstationSelectedPrAtomFamily(SCOPE_KEY)).viewState
    ).toMatchObject({
      activeTab: "commits",
      conversationDraft: "Preserve this draft",
      selectedCommitSha: "abc1234",
    });
    // One call for the initial load, one for the post-mutation
    // reconciliation — the remount reads the still-fresh cache and does not
    // trigger a third.
    expect(apiMocks.listIssueCommentsLocal).toHaveBeenCalledTimes(2);
  });

  it("does not let a stale in-flight refresh clobber a mutation, and lands the post-mutation reconciliation", async () => {
    // A dedicated PR/scope avoids any cache left warm by other tests in this
    // file (the module-level PR-detail cache persists across `it` blocks).
    const PR_RACE: PrIdentity = { ...PR, number: 111_201 };
    const scopeKey = workstationPrScopeKey(REPO_ID, REPO_PATH, PR_RACE.number);

    await act(async () => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, { pr: PR_RACE })
        )
      );
    });
    await waitForStore(
      store,
      () =>
        store.get(workstationSelectedPrAtomFamily(scopeKey)).loading === false
    );
    await waitForStore(
      store,
      () =>
        store.get(workstationPrDetailCallbackAtomFamily(scopeKey)).refresh !==
        null
    );
    expect(apiMocks.listPRCommitsLocal).toHaveBeenCalledTimes(1);

    // Call #2 (a manual background refresh) hangs on `listPRCommitsLocal`.
    // Call #3 (the post-mutation reconciliation) resolves immediately with
    // fresh data that already reflects the mutation — simulating that the
    // mutation landed on the server strictly after call #2 was dispatched.
    const staleCommitsFetch = deferred<Record<string, unknown>[]>();
    apiMocks.listPRCommitsLocal.mockImplementationOnce(
      () => staleCommitsFetch.promise
    );
    apiMocks.listIssueCommentsLocal.mockResolvedValueOnce([]); // call #2: pre-mutation snapshot
    apiMocks.listIssueCommentsLocal.mockResolvedValueOnce([COMMENT]); // call #3: server truth
    const FINAL_COMMITS = [{ sha: "final-commit" }];
    apiMocks.listPRCommitsLocal.mockResolvedValueOnce(FINAL_COMMITS); // call #3

    // Kick off the background refresh; it hangs.
    act(() => {
      store.get(workstationPrDetailCallbackAtomFamily(scopeKey)).refresh?.();
    });
    expect(apiMocks.listPRCommitsLocal).toHaveBeenCalledTimes(2);

    // Mutate while the refresh is still hanging.
    await act(async () => {
      await store
        .get(workstationPrDetailCallbackAtomFamily(scopeKey))
        .addComment?.(COMMENT.body);
    });

    // The reconciliation fetch (call #3) is a genuinely fresh request — it
    // must not be satisfied by the still-pending call #2 promise.
    await waitForStore(
      store,
      () =>
        store.get(workstationSelectedPrAtomFamily(scopeKey)).commits.length > 0
    );
    expect(apiMocks.listPRCommitsLocal).toHaveBeenCalledTimes(3);
    expect(apiMocks.listIssueCommentsLocal).toHaveBeenCalledTimes(3);

    let state = store.get(workstationSelectedPrAtomFamily(scopeKey));
    expect(state.conversation).toEqual([COMMENT]);
    expect(state.commits).toEqual(FINAL_COMMITS);
    expect(
      getCachedPrDetail(prDetailKey(REPO_FULL_NAME, PR_RACE.number))?.commits
    ).toEqual(FINAL_COMMITS);

    // Now let the stale, interrupted refresh resolve. Its pre-mutation data
    // must not clobber what the reconciliation already applied.
    await act(async () => {
      staleCommitsFetch.resolve([{ sha: "stale-commit" }]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    state = store.get(workstationSelectedPrAtomFamily(scopeKey));
    expect(state.conversation).toEqual([COMMENT]);
    expect(state.commits).toEqual(FINAL_COMMITS);
    expect(
      getCachedPrDetail(prDetailKey(REPO_FULL_NAME, PR_RACE.number))?.commits
    ).toEqual(FINAL_COMMITS);
  });

  it("keeps PR A's in-flight bundle cached when the panel switches to PR B before it resolves", async () => {
    const PR_A: PrIdentity = { ...PR, number: 111_101 };
    const PR_B: PrIdentity = { ...PR, number: 111_102, title: "Other PR" };
    const bScopeKey = workstationPrScopeKey(REPO_ID, REPO_PATH, PR_B.number);

    const aCommitsFetch = deferred<Record<string, unknown>[]>();
    apiMocks.listPRCommitsLocal.mockImplementationOnce(
      () => aCommitsFetch.promise
    );

    await act(async () => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, { pr: PR_A })
        )
      );
    });
    // Flush one tick so `repoFullName` resolves and A's initial load starts
    // (and hangs on `listPRCommitsLocal`).
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(apiMocks.listPRCommitsLocal).toHaveBeenCalledTimes(1);

    // Switch to PR B before A's fetch resolves. The hook instance is not
    // remounted (mirrors production: `PrDetailPanel` isn't keyed by PR).
    await act(async () => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, { pr: PR_B })
        )
      );
    });
    await waitForStore(
      store,
      () =>
        store.get(workstationSelectedPrAtomFamily(bScopeKey)).loading === false
    );

    // Now resolve A's hanging fetch.
    const aCommits = [{ sha: "a-commit" }];
    await act(async () => {
      aCommitsFetch.resolve(aCommits);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Per-PR request-id scoping means B superseding A never invalidated A's
    // own in-flight request — its result still lands in the shared cache.
    expect(
      getCachedPrDetail(prDetailKey(REPO_FULL_NAME, PR_A.number))?.commits
    ).toEqual(aCommits);
  });

  it("surfaces a failed inline comment as state.error, resets the submitting flag, and leaves the cache untouched", async () => {
    const PR_C: PrIdentity = { ...PR, number: 111_103 };
    const scopeKey = workstationPrScopeKey(REPO_ID, REPO_PATH, PR_C.number);
    apiMocks.getPRLocal.mockResolvedValue({
      head: { sha: "sha-c" },
      base: { ref: "develop" },
    });

    await act(async () => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, { pr: PR_C })
        )
      );
    });
    await waitForStore(
      store,
      () =>
        store.get(workstationSelectedPrAtomFamily(scopeKey)).loading === false
    );
    await waitForStore(
      store,
      () =>
        store.get(workstationPrDetailCallbackAtomFamily(scopeKey))
          .addInlineComment !== null
    );

    const key = prDetailKey(REPO_FULL_NAME, PR_C.number);
    const cacheBefore = getCachedPrDetail(key);

    apiMocks.createPrReviewCommentLocal.mockRejectedValueOnce(
      new Error("network down")
    );

    await act(async () => {
      await store
        .get(workstationPrDetailCallbackAtomFamily(scopeKey))
        .addInlineComment?.({ body: "nope", path: "a.ts", line: 1 });
    });

    const state = store.get(workstationSelectedPrAtomFamily(scopeKey));
    expect(state.error).toBe("network down");
    expect(state.submittingInlineComment).toBe(false);
    expect(getCachedPrDetail(key)).toEqual(cacheBefore);
    expect(apiMocks.createPrReviewCommentLocal).toHaveBeenCalledTimes(1);
  });

  it("propagates a new head SHA from the post-mutation reconciliation into the next inline comment", async () => {
    const PR_D: PrIdentity = { ...PR, number: 111_104 };
    const scopeKey = workstationPrScopeKey(REPO_ID, REPO_PATH, PR_D.number);
    apiMocks.getPRLocal.mockResolvedValueOnce({
      head: { sha: "sha-old" },
      base: { ref: "develop" },
    });
    apiMocks.getPRLocal.mockResolvedValue({
      head: { sha: "sha-new" },
      base: { ref: "develop" },
    });

    await act(async () => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, { pr: PR_D })
        )
      );
    });
    await waitForStore(
      store,
      () =>
        store.get(workstationSelectedPrAtomFamily(scopeKey)).loading === false
    );
    expect(store.get(workstationSelectedPrAtomFamily(scopeKey)).headSha).toBe(
      "sha-old"
    );
    await waitForStore(
      store,
      () =>
        store.get(workstationPrDetailCallbackAtomFamily(scopeKey))
          .addComment !== null
    );

    await act(async () => {
      await store
        .get(workstationPrDetailCallbackAtomFamily(scopeKey))
        .addComment?.(COMMENT.body);
    });

    // The post-mutation reconciliation fetch lands the new head SHA.
    await waitForStore(
      store,
      () =>
        store.get(workstationSelectedPrAtomFamily(scopeKey)).headSha ===
        "sha-new"
    );

    await act(async () => {
      await store
        .get(workstationPrDetailCallbackAtomFamily(scopeKey))
        .addInlineComment?.({ body: "inline", path: "a.ts", line: 2 });
    });

    expect(apiMocks.createPrReviewCommentLocal).toHaveBeenCalledWith(
      REPO_FULL_NAME,
      PR_D.number,
      expect.objectContaining({ commitId: "sha-new" })
    );
  });

  it("anchors a submitted review to the displayed head commit", async () => {
    const REVIEW_PR: PrIdentity = { ...PR, number: 111_106 };
    const scopeKey = workstationPrScopeKey(
      REPO_ID,
      REPO_PATH,
      REVIEW_PR.number
    );
    apiMocks.getPRLocal.mockResolvedValue({
      head: { sha: "displayed-head" },
      base: { ref: "develop" },
    });
    apiMocks.createPrReviewLocal.mockResolvedValue({
      id: 71,
      body: "Looks good.",
      state: "APPROVED",
      submitted_at: "2026-08-06T09:00:00.000Z",
      commit_id: "displayed-head",
      html_url: `${REVIEW_PR.url}#pullrequestreview-71`,
      user: { login: "reviewer", avatar_url: "" },
    });

    await act(async () => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, { pr: REVIEW_PR })
        )
      );
    });
    await waitForStore(
      store,
      () =>
        store.get(workstationPrDetailCallbackAtomFamily(scopeKey))
          .submitReview !== null
    );

    await act(async () => {
      await store
        .get(workstationPrDetailCallbackAtomFamily(scopeKey))
        .submitReview?.("APPROVE", "Looks good.");
    });

    expect(apiMocks.createPrReviewLocal).toHaveBeenCalledWith(
      REPO_FULL_NAME,
      REVIEW_PR.number,
      "APPROVE",
      "Looks good.",
      "displayed-head"
    );
  });

  it("publishes one shared dispatcher for PR-level merge, draft, state, and reviewer mutations", async () => {
    const ACTION_PR: PrIdentity = { ...PR, number: 111_105 };
    const scopeKey = workstationPrScopeKey(
      REPO_ID,
      REPO_PATH,
      ACTION_PR.number
    );
    apiMocks.getPRLocal.mockResolvedValue({
      state: "open",
      head: { sha: "expected-head" },
      base: { ref: "develop" },
      user: { login: "author" },
      requested_reviewers: [{ login: "old-reviewer", avatar_url: "" }],
    });

    await act(async () => {
      root?.render(
        React.createElement(
          Provider,
          { store },
          React.createElement(Harness, { pr: ACTION_PR })
        )
      );
    });
    await waitForStore(
      store,
      () =>
        store.get(workstationPrDetailCallbackAtomFamily(scopeKey))
          .mergePullRequest !== null
    );
    const callbacks = store.get(
      workstationPrDetailCallbackAtomFamily(scopeKey)
    );

    await act(async () => {
      await callbacks.mergePullRequest?.("squash");
      await callbacks.setPullRequestAutoMerge?.(true, "rebase");
      await callbacks.updatePullRequestDraft?.(true);
      await callbacks.updatePullRequestState?.("closed");
      await callbacks.updateRequestedReviewers?.(["new-reviewer"]);
    });

    expect(apiMocks.mergePRLocal).toHaveBeenCalledWith(
      REPO_FULL_NAME,
      ACTION_PR.number,
      "squash",
      "expected-head"
    );
    expect(apiMocks.setPRAutoMergeLocal).toHaveBeenCalledWith(
      REPO_FULL_NAME,
      ACTION_PR.number,
      true,
      "rebase",
      "expected-head"
    );
    expect(apiMocks.updatePRDraftStateLocal).toHaveBeenCalledWith(
      REPO_FULL_NAME,
      ACTION_PR.number,
      true
    );
    expect(apiMocks.updatePRStateLocal).toHaveBeenCalledWith(
      REPO_FULL_NAME,
      ACTION_PR.number,
      "closed"
    );
    expect(apiMocks.requestPRReviewersLocal).toHaveBeenCalledWith(
      REPO_FULL_NAME,
      ACTION_PR.number,
      ["new-reviewer"]
    );
    expect(apiMocks.removePRReviewersLocal).toHaveBeenCalledWith(
      REPO_FULL_NAME,
      ACTION_PR.number,
      ["old-reviewer"]
    );
  });
});
