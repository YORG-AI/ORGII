import { beforeEach, describe, expect, it } from "vitest";

import {
  type ChatPanelTabsState,
  chatPanelTabsAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { sessionsAtom } from "@src/store/session/sessionAtom";
import type { Session } from "@src/store/session/sessionAtom/types";
import { workstationActiveSessionIdAtom } from "@src/store/session/viewAtom";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";
import { STATION_MODE, stationModeAtom } from "@src/store/ui/simulatorAtom";
import {
  githubPrDetailTabFactory,
  workstationLayoutAtom,
} from "@src/store/workstation/tabs";
import type {
  GitHubIssueDetailTabData,
  GitHubPrDetailTabData,
} from "@src/types/githubDetail";
import { createInstrumentedStore } from "@src/util/core/state/instrumentedStore";

import {
  canMoveChatPanelTabToWorkstation,
  canMoveWorkstationPrTabToChatPanel,
  moveChatPanelTabToWorkstationAtom,
  moveWorkstationPrTabToChatPanelAtom,
} from "../chatPanelTabPlacementAtom";

function resetWorkstation(
  store: ReturnType<typeof createInstrumentedStore>
): void {
  store.set(workstationActiveSessionIdAtom, null);
  store.set(workstationLayoutAtom, {
    mainPane: { tabs: [], activeTabId: null },
  });
  store.set(chatPanelMaximizedAtom, true);
  store.set(stationModeAtom, STATION_MODE.AGENT_STATION);
}

function stateWith(
  tab: ChatPanelTabsState["tabs"][number]
): ChatPanelTabsState {
  return {
    tabs: [tab, { id: "launchpad", type: "start-page", title: "Launchpad" }],
    activeTabId: tab.id,
  };
}

describe("Chat Panel tab placement", () => {
  beforeEach(() => localStorage.clear());

  it("moves a PR tab into the equivalent My Station detail tab", () => {
    const store = createInstrumentedStore();
    const githubPr: GitHubPrDetailTabData = {
      prNumber: 964,
      prTitle: "Maximize chat when closing the last Launchpad tab",
      prUrl: "https://github.com/org/repo/pull/964",
      prStatus: "open",
      headBranch: "fix/chat",
      baseBranch: "main",
      additions: 14,
      deletions: 3,
      repoPath: "/repo",
      repoId: "org/repo",
    };
    store.set(
      chatPanelTabsAtom,
      stateWith({
        id: "chat-pr",
        type: "github-pr",
        title: "#964",
        githubPr,
      })
    );
    resetWorkstation(store);

    const moved = store.set(moveChatPanelTabToWorkstationAtom, "chat-pr");

    expect(moved).toBe(true);
    expect(store.get(chatPanelTabsAtom).tabs).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "chat-pr" })])
    );
    expect(store.get(workstationLayoutAtom).mainPane).toMatchObject({
      activeTabId: "github-pr-detail:/repo:964",
      tabs: [
        expect.objectContaining({
          id: "github-pr-detail:/repo:964",
          type: "github-pr-detail",
          data: githubPr,
        }),
      ],
    });
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(store.get(stationModeAtom)).toBe(STATION_MODE.MY_STATION);
  });

  it("moves an issue tab into the equivalent My Station detail tab", () => {
    const store = createInstrumentedStore();
    const githubIssue: GitHubIssueDetailTabData = {
      issueNumber: 42,
      issueTitle: "Keep tab ownership stable",
      repoPath: "/repo",
      remoteUrl: "https://github.com/org/repo/issues/42",
      stateScopeKey: "org/repo",
      authScope: "github.com",
      viewerLogin: "octocat",
    };
    store.set(
      chatPanelTabsAtom,
      stateWith({
        id: "chat-issue",
        type: "github-issue",
        title: "#42",
        githubIssue,
      })
    );
    resetWorkstation(store);

    const moved = store.set(moveChatPanelTabToWorkstationAtom, "chat-issue");

    expect(moved).toBe(true);
    expect(store.get(workstationLayoutAtom).mainPane).toMatchObject({
      activeTabId: "github-issue-detail:/repo:42",
      tabs: [
        expect.objectContaining({
          id: "github-issue-detail:/repo:42",
          type: "github-issue-detail",
          data: githubIssue,
        }),
      ],
    });
    expect(store.get(stationModeAtom)).toBe(STATION_MODE.MY_STATION);
  });

  it("moves a My Station PR tab into the equivalent Chat Panel tab", () => {
    const store = createInstrumentedStore();
    const githubPr: GitHubPrDetailTabData = {
      prNumber: 1028,
      prTitle: "Add autostash to rebase pulls",
      prUrl: "https://github.com/org/repo/pull/1028",
      prStatus: "merged",
      headBranch: "fix/pull-rebase-autostash",
      baseBranch: "develop",
      additions: 58,
      deletions: 28,
      repoPath: "/repo",
      repoId: "org/repo",
    };
    const workstationTab = githubPrDetailTabFactory(githubPr);
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [workstationTab], activeTabId: workstationTab.id },
    });
    store.set(chatPanelTabsAtom, {
      tabs: [{ id: "launchpad", type: "start-page", title: "Launchpad" }],
      activeTabId: "launchpad",
    });

    expect(canMoveWorkstationPrTabToChatPanel(workstationTab)).toBe(true);
    expect(
      store.set(moveWorkstationPrTabToChatPanelAtom, workstationTab.id)
    ).toBe(true);

    expect(store.get(workstationLayoutAtom).mainPane).toEqual({
      tabs: [],
      activeTabId: null,
    });
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: "github-pr:/repo:1028",
      tabs: expect.arrayContaining([
        expect.objectContaining({
          id: "github-pr:/repo:1028",
          type: "github-pr",
          title: "#1028 Add autostash to rebase pulls",
          githubPr,
        }),
      ]),
    });
  });

  it("focuses and refreshes an existing Chat Panel PR when moving", () => {
    const store = createInstrumentedStore();
    const githubPr: GitHubPrDetailTabData = {
      prNumber: 1028,
      prTitle: "Updated PR title",
      prUrl: "https://github.com/org/repo/pull/1028",
      prStatus: "open",
      headBranch: "fix/tabs",
      baseBranch: "main",
      repoPath: "/repo",
      repoId: "org/repo",
    };
    const workstationTab = githubPrDetailTabFactory(githubPr);
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [workstationTab], activeTabId: workstationTab.id },
    });
    store.set(chatPanelTabsAtom, {
      tabs: [
        { id: "launchpad", type: "start-page", title: "Launchpad" },
        {
          id: "existing-pr",
          type: "github-pr",
          title: "Stale PR title",
          githubPr: { ...githubPr, prTitle: "Stale PR title" },
        },
      ],
      activeTabId: "launchpad",
    });

    expect(
      store.set(moveWorkstationPrTabToChatPanelAtom, workstationTab.id)
    ).toBe(true);

    const chatState = store.get(chatPanelTabsAtom);
    expect(chatState.activeTabId).toBe("existing-pr");
    expect(chatState.tabs.filter((tab) => tab.type === "github-pr")).toEqual([
      expect.objectContaining({
        id: "existing-pr",
        title: "#1028 Updated PR title",
        githubPr,
      }),
    ]);
    expect(store.get(workstationLayoutAtom).mainPane.tabs).toEqual([]);
  });

  it("does not move a malformed My Station PR payload", () => {
    const store = createInstrumentedStore();
    const malformedTab = {
      id: "github-pr-detail:/repo:1028",
      type: "github-pr-detail" as const,
      title: "#1028",
      data: {
        prNumber: 1028,
        prTitle: "Missing the canonical PR URL",
        prStatus: "open",
        headBranch: "fix/tabs",
        repoPath: "/repo",
      },
    };
    store.set(workstationLayoutAtom, {
      mainPane: { tabs: [malformedTab], activeTabId: malformedTab.id },
    });
    store.set(chatPanelTabsAtom, {
      tabs: [{ id: "launchpad", type: "start-page", title: "Launchpad" }],
      activeTabId: "launchpad",
    });

    expect(canMoveWorkstationPrTabToChatPanel(malformedTab)).toBe(false);
    expect(
      store.set(moveWorkstationPrTabToChatPanelAtom, malformedTab.id)
    ).toBe(false);
    expect(store.get(workstationLayoutAtom).mainPane.tabs).toEqual([
      malformedTab,
    ]);
    expect(store.get(chatPanelTabsAtom).tabs).toEqual([
      { id: "launchpad", type: "start-page", title: "Launchpad" },
    ]);
  });

  it("moves a session through the canonical session transfer", () => {
    const store = createInstrumentedStore();
    const session: Session = {
      session_id: "session-1",
      name: "Live session",
      status: "completed",
      created_at: "2026-08-25T00:00:00.000Z",
      updated_at: "2026-08-25T00:00:00.000Z",
      repoPath: "/repo",
    };
    store.set(sessionsAtom, [session]);
    store.set(
      chatPanelTabsAtom,
      stateWith({
        id: "chat-session",
        type: "session",
        title: "Live session",
        sessionId: session.session_id,
      })
    );
    resetWorkstation(store);

    const moved = store.set(moveChatPanelTabToWorkstationAtom, "chat-session");

    expect(moved).toBe(true);
    expect(store.get(workstationLayoutAtom).mainPane.activeTabId).toBe(
      "chat-session:session-1"
    );
    expect(store.get(stationModeAtom)).toBe(STATION_MODE.MY_STATION);
  });

  it("does not offer or move tabs without a lossless My Station mapping", () => {
    const store = createInstrumentedStore();
    const launchpad = {
      id: "launchpad",
      type: "start-page" as const,
      title: "Launchpad",
    };
    store.set(chatPanelTabsAtom, {
      tabs: [launchpad],
      activeTabId: launchpad.id,
    });
    resetWorkstation(store);

    expect(canMoveChatPanelTabToWorkstation(launchpad)).toBe(false);
    expect(store.set(moveChatPanelTabToWorkstationAtom, launchpad.id)).toBe(
      false
    );
    expect(store.get(chatPanelTabsAtom).tabs).toEqual([launchpad]);
    expect(store.get(workstationLayoutAtom).mainPane.tabs).toEqual([]);
    expect(store.get(stationModeAtom)).toBe(STATION_MODE.AGENT_STATION);
  });
});
