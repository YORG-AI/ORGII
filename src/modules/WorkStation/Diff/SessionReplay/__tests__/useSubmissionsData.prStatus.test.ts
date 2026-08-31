// @vitest-environment jsdom
//
// Probe harness for the PR-status branch of `useSubmissionsData`.
//
// The hook's PR-status effect is keyed on `prStatusFetchKey` — a sorted join
// of `repoFullName#prNumber` — which by construction cannot observe a PR being
// merged on GitHub. These tests pin the two behaviors that closes that hole:
// `diffRefreshNonce` re-reads status, and a failed read publishes the explicit
// `unknown` key instead of letting the row default to a green "open" badge.
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

import { getGitCommitDiff, getGitCommits } from "@src/api/http/git";
import { getPRLocal } from "@src/api/tauri/github";
import { getOrgtrackDiffReplayPreview } from "@src/api/tauri/lineage";
import type { SessionEvent } from "@src/engines/SessionCore/core/types";
import { loadEvents } from "@src/engines/SessionCore/storage/cacheAdapter";
import { PR_STATUS_UNKNOWN } from "@src/shared/pr/prStatus";
import type { Repo } from "@src/store/repo/types";

import type { SubmissionRepoContext } from "../submissionsArtifacts";
import {
  type UseSubmissionsDataResult,
  useSubmissionsData,
} from "../useSubmissionsData";

vi.mock("@src/api/tauri/github", () => ({
  getPRLocal: vi.fn(),
}));

vi.mock("@src/api/tauri/lineage", () => ({
  getOrgtrackDiffReplayPreview: vi.fn(),
}));

vi.mock("@src/api/http/git", () => ({
  getGitCommits: vi.fn(),
  getGitCommitDiff: vi.fn(),
}));

vi.mock("@src/engines/SessionCore/storage/cacheAdapter", () => ({
  loadEvents: vi.fn(),
}));

const getPRLocalMock = vi.mocked(getPRLocal);
const getOrgtrackDiffReplayPreviewMock = vi.mocked(
  getOrgtrackDiffReplayPreview
);
const getGitCommitsMock = vi.mocked(getGitCommits);
const getGitCommitDiffMock = vi.mocked(getGitCommitDiff);
const loadEventsMock = vi.mocked(loadEvents);

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

const REPO_FULL_NAME = "acme/repo";
const PR_NUMBER = 42;
const NO_REPOS: readonly Repo[] = [];

/**
 * An assistant message carrying a GitHub PR URL — the cheapest event shape
 * that makes `collectSubmissionArtifacts` emit a `pullRequest` artifact.
 */
function prMentionEvent(): SessionEvent {
  return {
    chunk_id: "chunk-1",
    id: "event-1",
    sessionId: "session-1",
    createdAt: "2026-08-23T00:00:00.000Z",
    functionName: "assistant_message",
    uiCanonical: "assistant_message",
    actionType: "assistant",
    args: {},
    result: {},
    source: "assistant",
    displayText: `Opened https://github.com/${REPO_FULL_NAME}/pull/${PR_NUMBER} for review.`,
    displayStatus: "completed",
    displayVariant: "message",
    activityStatus: "agent",
  };
}

interface ProbeProps {
  onValue: (value: UseSubmissionsDataResult) => void;
  simulatorEvents: readonly SessionEvent[];
  fallbackRepoContext: SubmissionRepoContext;
  diffRefreshNonce: number;
}

function Probe({
  onValue,
  simulatorEvents,
  fallbackRepoContext,
  diffRefreshNonce,
}: ProbeProps) {
  onValue(
    useSubmissionsData({
      sessionId: "session-1",
      simulatorEvents,
      fallbackRepoContext,
      repos: NO_REPOS,
      diffRefreshNonce,
    })
  );
  return null;
}

describe("useSubmissionsData PR status", () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: UseSubmissionsDataResult | null;
  let events: readonly SessionEvent[];

  beforeAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    // `reset`, not `clear`: these tests queue one-shot results with
    // `mockResolvedValueOnce`, and an unconsumed one-shot survives
    // `clearAllMocks` and leaks into the next test.
    vi.resetAllMocks();
    latest = null;
    events = [prMentionEvent()];
    getOrgtrackDiffReplayPreviewMock.mockResolvedValue({
      finalDiffs: [],
      submissionCommits: [],
    });
    loadEventsMock.mockResolvedValue([]);
    // No git history and no direct SHA lookup: these fixtures carry a PR and no
    // commits, so the resolve effect has nothing to upgrade.
    getGitCommitsMock.mockResolvedValue(undefined);
    getGitCommitDiffMock.mockResolvedValue(undefined);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
  });

  /**
   * Re-renders with a **fresh** `fallbackRepoContext` object every time, which
   * is what the real host does: `SessionReplay/index.tsx` rebuilds it as an
   * object literal on every replay-cursor step.
   */
  async function render(diffRefreshNonce: number): Promise<void> {
    await act(async () => {
      root.render(
        createElement(Probe, {
          onValue: (value) => {
            latest = value;
          },
          simulatorEvents: events,
          fallbackRepoContext: { repoId: "repo-1", repoPath: "/tmp/repo-1" },
          diffRefreshNonce,
        })
      );
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }

  function statusKey(): string | undefined {
    const pullRequests = latest?.pullRequestsWithStatus ?? [];
    expect(pullRequests).toHaveLength(1);
    return pullRequests[0].statusKey;
  }

  it("re-reads GitHub status when diffRefreshNonce is bumped", async () => {
    getPRLocalMock.mockResolvedValueOnce({ state: "open", merged: false });
    await render(0);
    expect(statusKey()).toBe("open");
    expect(getPRLocalMock).toHaveBeenCalledTimes(1);

    // The PR is merged on GitHub. Nothing about the local PR set changes, so
    // `prStatusFetchKey` is byte-identical — only the nonce can force a re-read.
    getPRLocalMock.mockResolvedValueOnce({ state: "closed", merged: true });
    await render(1);

    expect(getPRLocalMock).toHaveBeenCalledTimes(2);
    expect(getPRLocalMock).toHaveBeenLastCalledWith(REPO_FULL_NAME, PR_NUMBER);
    expect(statusKey()).toBe("merged");
  });

  it("reports unknown rather than open when the status read fails", async () => {
    getPRLocalMock.mockRejectedValueOnce(new Error("no github credentials"));
    await render(0);

    // The point of the assertion: NOT "open". A green Open badge on a PR whose
    // state was never read is a claim the hook has no basis for.
    expect(statusKey()).toBe(PR_STATUS_UNKNOWN);
  });

  it("recovers a merged badge after a transient failure", async () => {
    getPRLocalMock.mockRejectedValueOnce(new Error("rate limited"));
    await render(0);
    expect(statusKey()).toBe(PR_STATUS_UNKNOWN);

    getPRLocalMock.mockResolvedValueOnce({ state: "closed", merged: true });
    await render(1);

    expect(statusKey()).toBe("merged");
  });

  it("does not re-fetch when only the replay cursor advances", async () => {
    getPRLocalMock.mockResolvedValue({ state: "open", merged: false });
    await render(0);
    expect(getPRLocalMock).toHaveBeenCalledTimes(1);

    // Same nonce, same PR set, but a new `fallbackRepoContext` identity and a
    // new derived `pullRequests` array — the shape every replay-cursor step
    // produces. Listing `submissionsData.pullRequests` in the effect deps would
    // turn this into a `getPRLocal` call storm.
    for (let step = 0; step < 3; step += 1) {
      events = [prMentionEvent()];
      await render(0);
    }

    expect(getPRLocalMock).toHaveBeenCalledTimes(1);
    expect(statusKey()).toBe("open");
  });
});
