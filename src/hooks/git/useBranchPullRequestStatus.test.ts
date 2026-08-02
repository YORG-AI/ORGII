// @vitest-environment jsdom
import { act, createElement } from "react";
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

import { getGitDefaultBranch } from "@src/api/http/git/branches";
import { getGitRemotes } from "@src/api/http/git/remotes";
import {
  findPullRequestLocal,
  getChecksLocal,
  getGitCredentialForRemote,
  getPRLocal,
} from "@src/api/tauri/github";
import {
  BRANCH_CI_POLL_BASE_MS,
  BRANCH_CI_POLL_MAX_MS,
  BRANCH_CI_SAFETY_POLL_MS,
  clearBranchPullRequestStatusCache,
} from "@src/services/git/branchPullRequestStatus";
import { announceBranchRemoteMutation } from "@src/util/git/branchRemoteMutation";

import {
  type UseBranchPullRequestStatusOptions,
  type UseBranchPullRequestStatusResult,
  useBranchPullRequestStatus,
} from "./useBranchPullRequestStatus";

vi.mock("@src/api/http/git/branches", () => ({
  getGitDefaultBranch: vi.fn(),
}));

vi.mock("@src/api/http/git/remotes", () => ({
  getGitRemotes: vi.fn(),
}));

vi.mock("@src/api/tauri/github", () => ({
  findPullRequestLocal: vi.fn(),
  getChecksLocal: vi.fn(),
  getGitCredentialForRemote: vi.fn(),
  getPRLocal: vi.fn(),
}));

const getGitDefaultBranchMock = vi.mocked(getGitDefaultBranch);
const getGitRemotesMock = vi.mocked(getGitRemotes);
const findPullRequestLocalMock = vi.mocked(findPullRequestLocal);
const getChecksLocalMock = vi.mocked(getChecksLocal);
const getGitCredentialForRemoteMock = vi.mocked(getGitCredentialForRemote);
const getPRLocalMock = vi.mocked(getPRLocal);

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

function Probe({
  onValue,
  options,
}: {
  onValue: (value: UseBranchPullRequestStatusResult) => void;
  options: UseBranchPullRequestStatusOptions;
}) {
  onValue(useBranchPullRequestStatus(options));
  return null;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("useBranchPullRequestStatus", () => {
  let container: HTMLDivElement;
  let root: Root;
  let visibilityState: DocumentVisibilityState;

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    clearBranchPullRequestStatusCache();
    visibilityState = "visible";
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibilityState,
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    getGitRemotesMock.mockResolvedValue({
      remotes: [
        {
          name: "origin",
          url: "git@github.com:acme/repo.git",
          fetch_url: "git@github.com:acme/repo.git",
          push_url: "git@github.com:acme/repo.git",
        },
      ],
    });
    getGitDefaultBranchMock.mockResolvedValue({ name: "main" });
    getGitCredentialForRemoteMock.mockResolvedValue({
      connection_id: "connection-1",
      source: "github",
      username: "octocat",
      token: "secret",
    });
    findPullRequestLocalMock.mockResolvedValue({
      number: 12,
      state: "open",
      url: "https://github.com/acme/repo/pull/12",
    });
    getPRLocalMock.mockResolvedValue({
      head: { sha: "abc" },
    });
    getChecksLocalMock.mockResolvedValue({
      sha: "abc",
      state: "success",
      check_runs: [
        {
          id: 1,
          name: "test",
          status: "completed",
          conclusion: "success",
          details_url: null,
          started_at: null,
          completed_at: null,
          output_title: null,
          app_name: "CI",
        },
      ],
      statuses: [],
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.deleteProperty(document, "visibilityState");
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function runningChecks() {
    return {
      sha: "abc",
      state: "pending",
      check_runs: [
        {
          id: 1,
          name: "test",
          status: "in_progress",
          conclusion: null,
          details_url: null,
          started_at: null,
          completed_at: null,
          output_title: null,
          app_name: "CI",
        },
      ],
      statuses: [],
    };
  }

  afterAll(() => {
    Reflect.deleteProperty(reactActEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("defers GitHub work while hidden and loads once visible", async () => {
    visibilityState = "hidden";
    let latest!: UseBranchPullRequestStatusResult;

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
          },
          onValue: (value) => {
            latest = value;
          },
        })
      );
    });
    expect(getGitRemotesMock).not.toHaveBeenCalled();

    visibilityState = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(findPullRequestLocalMock).toHaveBeenCalledWith(
      "acme/repo",
      "feature"
    );
    expect(getChecksLocalMock).toHaveBeenCalledWith("acme/repo", "abc");
    expect(latest.pr?.number).toBe(12);
    expect(latest.ciStatus).toBe("success");
    expect(latest.compareUrl).toBe(
      "https://github.com/acme/repo/compare/main...feature"
    );
  });

  it("does not repeat PR or CI requests on a visibility return within the TTL", async () => {
    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
          },
          onValue: () => undefined,
        })
      );
    });
    expect(findPullRequestLocalMock).toHaveBeenCalledTimes(1);
    expect(getPRLocalMock).toHaveBeenCalledTimes(1);
    expect(getChecksLocalMock).toHaveBeenCalledTimes(1);

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    visibilityState = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(findPullRequestLocalMock).toHaveBeenCalledTimes(1);
    expect(getPRLocalMock).toHaveBeenCalledTimes(1);
    expect(getChecksLocalMock).toHaveBeenCalledTimes(1);
  });

  it("ignores a late PR response after the active branch changes", async () => {
    const oldBranchRequest = deferred<{
      number: number;
      state: string;
      url: string;
    } | null>();
    findPullRequestLocalMock.mockImplementation((_repo, branch) =>
      branch === "feature-old"
        ? oldBranchRequest.promise
        : Promise.resolve({
            number: 22,
            state: "open",
            url: "https://github.com/acme/repo/pull/22",
          })
    );
    let latest!: UseBranchPullRequestStatusResult;
    const onValue = (value: UseBranchPullRequestStatusResult) => {
      latest = value;
    };

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature-old",
          },
          onValue,
        })
      );
    });

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature-new",
          },
          onValue,
        })
      );
    });
    expect(latest.pr?.number).toBe(22);

    await act(async () => {
      oldBranchRequest.resolve({
        number: 11,
        state: "open",
        url: "https://github.com/acme/repo/pull/11",
      });
    });

    expect(latest.pr?.number).toBe(22);
    expect(latest.compareUrl).toContain("feature-new");
  });

  it("re-reads while checks run and stops once they settle", async () => {
    vi.useFakeTimers();
    getChecksLocalMock
      .mockResolvedValueOnce(runningChecks())
      .mockResolvedValueOnce(runningChecks());

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
            poll: true,
          },
          onValue: () => undefined,
        })
      );
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BRANCH_CI_POLL_BASE_MS);
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(2);

    // Second poll returns the settled default (`success`), so the schedule ends
    // even though far more than the max interval elapses afterwards.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(BRANCH_CI_POLL_BASE_MS * 2);
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BRANCH_CI_POLL_MAX_MS * 4);
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(3);
  });

  it("discovers a newly-created PR immediately after branch invalidation", async () => {
    findPullRequestLocalMock.mockResolvedValueOnce(null);
    let latest!: UseBranchPullRequestStatusResult;

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
            poll: true,
          },
          onValue: (value) => {
            latest = value;
          },
        })
      );
    });
    expect(latest.pr).toBeNull();

    await act(async () => {
      announceBranchRemoteMutation({
        repoId: "repo-1",
        repoPath: "/repo",
        branchName: "feature",
        reason: "pull-request-created",
      });
    });

    expect(findPullRequestLocalMock).toHaveBeenCalledTimes(2);
    expect(latest.pr?.number).toBe(12);
    expect(latest.ciStatus).toBe("success");
  });

  it("defers a hidden push invalidation and forces it on visibility return", async () => {
    getPRLocalMock
      .mockResolvedValueOnce({ head: { sha: "abc" } })
      .mockResolvedValueOnce({ head: { sha: "def" } });
    getChecksLocalMock
      .mockResolvedValueOnce({
        ...runningChecks(),
        sha: "abc",
        state: "success",
        check_runs: [
          {
            ...runningChecks().check_runs[0],
            status: "completed",
            conclusion: "success",
          },
        ],
      })
      .mockResolvedValueOnce({ ...runningChecks(), sha: "def" });
    let latest!: UseBranchPullRequestStatusResult;

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
            poll: true,
          },
          onValue: (value) => {
            latest = value;
          },
        })
      );
    });
    expect(latest.ciStatus).toBe("success");

    visibilityState = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    await act(async () => {
      announceBranchRemoteMutation({
        repoId: "repo-1",
        repoPath: "/repo",
        branchName: "feature",
        reason: "push",
      });
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(1);

    visibilityState = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    expect(getChecksLocalMock).toHaveBeenLastCalledWith("acme/repo", "def");
    expect(latest.ciStatus).toBe("pending");
  });

  it("forces a new PR-head read when local HEAD changes", async () => {
    getPRLocalMock
      .mockResolvedValueOnce({ head: { sha: "abc" } })
      .mockResolvedValueOnce({ head: { sha: "def" } });
    getChecksLocalMock
      .mockResolvedValueOnce({
        ...runningChecks(),
        sha: "abc",
        state: "success",
        check_runs: [
          {
            ...runningChecks().check_runs[0],
            status: "completed",
            conclusion: "success",
          },
        ],
      })
      .mockResolvedValueOnce({ ...runningChecks(), sha: "def" });
    let latest!: UseBranchPullRequestStatusResult;
    const onValue = (value: UseBranchPullRequestStatusResult) => {
      latest = value;
    };

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
            headRevision: "abc1234",
            poll: true,
          },
          onValue,
        })
      );
    });
    expect(latest.ciStatus).toBe("success");

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
            headRevision: "def5678",
            poll: true,
          },
          onValue,
        })
      );
    });

    expect(getPRLocalMock).toHaveBeenCalledTimes(2);
    expect(getChecksLocalMock).toHaveBeenLastCalledWith("acme/repo", "def");
    expect(latest.ciStatus).toBe("pending");
  });

  it("uses only a slow safety refresh after settled CI", async () => {
    vi.useFakeTimers();

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
            poll: true,
          },
          onValue: () => undefined,
        })
      );
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BRANCH_CI_SAFETY_POLL_MS - 1);
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(2);
  });

  it("never schedules a poll when tracing is not requested", async () => {
    vi.useFakeTimers();
    getChecksLocalMock.mockResolvedValue(runningChecks());

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
          },
          onValue: () => undefined,
        })
      );
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(BRANCH_CI_POLL_MAX_MS * 4);
    });
    expect(getChecksLocalMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose a closed PR or request checks for it", async () => {
    findPullRequestLocalMock.mockResolvedValue({
      number: 12,
      state: "closed",
      url: "https://github.com/acme/repo/pull/12",
    });
    let latest!: UseBranchPullRequestStatusResult;

    await act(async () => {
      root.render(
        createElement(Probe, {
          options: {
            repoId: "repo-1",
            repoPath: "/repo",
            branchName: "feature",
          },
          onValue: (value) => {
            latest = value;
          },
        })
      );
    });

    expect(latest.pr).toBeNull();
    expect(latest.ciStatus).toBeNull();
    expect(getPRLocalMock).not.toHaveBeenCalled();
    expect(getChecksLocalMock).not.toHaveBeenCalled();
  });
});
