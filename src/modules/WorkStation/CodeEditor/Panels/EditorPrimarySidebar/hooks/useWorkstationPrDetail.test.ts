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
  workstationPrDetailCallbackAtomFamily,
  workstationPrScopeKey,
  workstationSelectedPrAtomFamily,
} from "@src/store/workstation/codeEditor/workstationSelectedPrAtom";

import { useWorkstationPrDetail } from "./useWorkstationPrDetail";

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
  replyPrReviewCommentLocal: vi.fn(),
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
  replyPrReviewCommentLocal: apiMocks.replyPrReviewCommentLocal,
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
type Store = ReturnType<typeof createStore>;

function Harness() {
  useWorkstationPrDetail({
    repoPath: REPO_PATH,
    repoId: REPO_ID,
    pr: PR,
  });
  const state = useAtomValue(workstationSelectedPrAtomFamily(SCOPE_KEY));
  return React.createElement(
    "div",
    { "data-testid": "conversation" },
    state.conversation.map((comment) => comment.body).join("\n")
  );
}

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
    apiMocks.createIssueCommentLocal.mockResolvedValue(COMMENT);

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

    await act(async () => {
      await store
        .get(workstationPrDetailCallbackAtomFamily(SCOPE_KEY))
        .addComment?.(COMMENT.body);
    });
    expect(
      store.get(workstationSelectedPrAtomFamily(SCOPE_KEY)).conversation
    ).toEqual([COMMENT]);

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
    expect(apiMocks.listIssueCommentsLocal).toHaveBeenCalledTimes(1);
  });
});
