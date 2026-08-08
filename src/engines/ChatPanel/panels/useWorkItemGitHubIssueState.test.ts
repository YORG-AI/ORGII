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

import type { GitHubIssueInteractionConfig } from "@src/modules/ProjectManager/WorkItems/components/WorkItemContent/types";
import { resetGitHubIssueDetailCoordinator } from "@src/modules/shared/githubIssueDetailCoordinator";
import { workstationIssueDetailScopeKey } from "@src/store/workstation/codeEditor/workstationIssueAtom";

import { useWorkItemGitHubIssueState } from "./useWorkItemGitHubIssueState";

const mocks = vi.hoisted(() => ({
  resolveGitHubIssueRemoteUrl: vi.fn(),
  useGitHubIssueDetailState: vi.fn(),
}));

vi.mock("@src/modules/ProjectManager/WorkItems/githubIssueRemote", () => ({
  resolveGitHubIssueRemoteUrl: mocks.resolveGitHubIssueRemoteUrl,
}));

vi.mock("@src/modules/shared/hooks/useGitHubIssueDetailState", () => ({
  useGitHubIssueDetailState: mocks.useGitHubIssueDetailState,
}));

function createInteraction(): GitHubIssueInteractionConfig {
  return {
    viewer: null,
    issueState: "open",
    duplicateCandidates: [],
    duplicateCandidatesLoaded: false,
    loadingDuplicateCandidates: false,
    duplicateCandidatesError: false,
    loading: false,
    canComment: false,
    canEditBody: false,
    canManageStatus: false,
    submittingComment: false,
    updatingBody: false,
    updatingStatus: false,
    error: null,
    onAddComment: vi.fn(async () => undefined),
    onUpdateBody: vi.fn(async () => undefined),
    onLoadDuplicateCandidates: vi.fn(async () => undefined),
    onStatusChange: vi.fn(async () => undefined),
  };
}

function Probe({
  enabled = true,
  repoPath = "/workspace/orgii",
  shortId = "705",
}: {
  enabled?: boolean;
  repoPath?: string;
  shortId?: string;
}) {
  const state = useWorkItemGitHubIssueState({
    enabled,
    repoPath,
    shortId,
    stateScopeKey: "work-item-github-state-test",
  });

  return createElement("div", {
    "data-testid": "probe",
    "data-has-interaction": String(Boolean(state.interaction)),
    "data-loading": String(state.interaction?.loading),
    "data-timeline-count": String(state.timeline?.items.length ?? 0),
  });
}

describe("useWorkItemGitHubIssueState", () => {
  let container: HTMLDivElement;
  let root: Root;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    resetGitHubIssueDetailCoordinator();
    mocks.resolveGitHubIssueRemoteUrl.mockResolvedValue(
      "git@github.com:org2AI/ORG2.git"
    );
    mocks.useGitHubIssueDetailState.mockImplementation(
      ({
        issueNumber,
        remoteUrl,
      }: {
        issueNumber?: number;
        remoteUrl?: string;
      }) => ({
        selectedState: {
          issue: remoteUrl ? { number: issueNumber } : null,
          timeline: remoteUrl ? [{ id: 1, event: "commented" }] : [],
          loading: false,
          timelineLoading: false,
          error: null,
          submittingComment: false,
        },
        interaction: createInteraction(),
        assigneeConfig: undefined,
      })
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("hydrates the canonical interaction and timeline from the linked checkout", async () => {
    let resolveRemoteUrl: ((remoteUrl: string) => void) | undefined;
    mocks.resolveGitHubIssueRemoteUrl.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          resolveRemoteUrl = resolve;
        })
    );

    await act(async () => {
      root.render(createElement(Probe));
    });

    expect(
      container
        .querySelector("[data-testid='probe']")
        ?.getAttribute("data-loading")
    ).toBe("true");

    await act(async () => {
      resolveRemoteUrl?.("git@github.com:org2AI/ORG2.git");
      await Promise.resolve();
    });

    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='probe']")
          ?.getAttribute("data-loading")
      ).toBe("false");
    });

    expect(mocks.resolveGitHubIssueRemoteUrl).toHaveBeenCalledWith(
      "/workspace/orgii"
    );
    expect(mocks.useGitHubIssueDetailState).toHaveBeenLastCalledWith({
      issueNumber: 705,
      repoPath: "/workspace/orgii",
      remoteUrl: "git@github.com:org2AI/ORG2.git",
      stateScopeKey: workstationIssueDetailScopeKey("/workspace/orgii", 705),
    });
    expect(
      container
        .querySelector("[data-testid='probe']")
        ?.getAttribute("data-timeline-count")
    ).toBe("1");
  });

  it("does not resolve or expose GitHub state for local Work Items", () => {
    act(() => root.render(createElement(Probe, { enabled: false })));

    expect(mocks.resolveGitHubIssueRemoteUrl).not.toHaveBeenCalled();
    expect(
      container
        .querySelector("[data-testid='probe']")
        ?.getAttribute("data-has-interaction")
    ).toBe("false");
  });

  it("does not expose a dead composer when no GitHub remote resolves", async () => {
    mocks.resolveGitHubIssueRemoteUrl.mockResolvedValue(null);

    await act(async () => {
      root.render(createElement(Probe));
    });
    await vi.waitFor(() => {
      expect(
        container
          .querySelector("[data-testid='probe']")
          ?.getAttribute("data-has-interaction")
      ).toBe("false");
    });
  });

  it("ignores a stale remote lookup after the Work Item scope changes", async () => {
    const pending = new Map<string, (remoteUrl: string) => void>();
    mocks.resolveGitHubIssueRemoteUrl.mockImplementation(
      (repoPath: string) =>
        new Promise<string>((resolve) => {
          pending.set(repoPath, resolve);
        })
    );

    act(() => {
      root.render(
        createElement(Probe, {
          repoPath: "/workspace/first",
          shortId: "705",
        })
      );
    });
    act(() => {
      root.render(
        createElement(Probe, {
          repoPath: "/workspace/second",
          shortId: "706",
        })
      );
    });

    await act(async () => {
      pending.get("/workspace/first")?.("git@github.com:org/first.git");
      await Promise.resolve();
    });
    expect(
      mocks.useGitHubIssueDetailState.mock.calls.some(
        ([options]) => options.remoteUrl === "git@github.com:org/first.git"
      )
    ).toBe(false);

    await act(async () => {
      pending.get("/workspace/second")?.("git@github.com:org/second.git");
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(mocks.useGitHubIssueDetailState).toHaveBeenLastCalledWith({
        issueNumber: 706,
        repoPath: "/workspace/second",
        remoteUrl: "git@github.com:org/second.git",
        stateScopeKey: workstationIssueDetailScopeKey("/workspace/second", 706),
      });
    });
  });
});
