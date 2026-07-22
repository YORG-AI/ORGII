import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "@src/store/session/sessionAtom/types";
import type { KanbanReplayEvent } from "@src/store/ui/kanbanReplayAtom";

function makeSession(
  sessionId: string,
  overrides: Partial<Session> = {}
): Session {
  const now = "2026-01-01T00:00:00.000Z";
  return {
    session_id: sessionId,
    status: "completed",
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

async function loadChatPanelTabAtoms() {
  const { createInstrumentedStore } =
    await import("@src/util/core/state/instrumentedStore");
  const store = createInstrumentedStore();
  const { activeSessionIdAtom, sessionViewAtom } =
    await import("@src/store/session/viewAtom");
  const { sessionsAtom } = await import("@src/store/session/sessionAtom");
  const {
    kanbanReplayBoundsAtom,
    kanbanReplayCursorAtom,
    kanbanReplayEventsAtom,
    kanbanReplayModeAtom,
    kanbanReplayPlayingAtom,
    kanbanReplaySpeedAtom,
  } = await import("@src/store/ui/kanbanReplayAtom");
  const { kanbanDetailPanelVisibleAtom, kanbanSelectedTaskIdAtom } =
    await import("@src/store/ui/kanbanViewStateAtom");
  const { workManagementCreatorVisibleAtom } =
    await import("@src/store/ui/workManagementCreatorAtom");
  const {
    activateChatPanelTabAtom,
    activeWorkManagementSectionAtom,
    addChatPanelTerminalTabAtom,
    addChatPanelLaunchpadTabAtom,
    chatPanelTabsAtom,
    closeChatPanelTabAtom,
    closeOtherChatPanelTabsAtom,
    closeProjectOrgChatPanelTabsAtom,
    closeWorkItemChatPanelTabAtom,
    normalizePersistedChatPanelTabsState,
    openOrganizationInChatPanelTabAtom,
    openCreateTargetInChatPanelStartPageAtom,
    openWorkManagementChatPanelTabAtom,
    openOrFocusChatPanelStartPageTabAtom,
    openRuntimeInChatPanelTabAtom,
    openOrFocusSessionInChatPanelTabAtom,
    openOrReplaceSessionInChatPanelTabAtom,
    openProjectInChatPanelTabAtom,
    openSessionInNewChatTabAtom,
    openWorkItemInChatPanelTabAtom,
    prevChatPanelTabAtom,
    setChatPanelTabTitleAtom,
    syncActiveChatPanelTabStateAtom,
  } = await import("../chatPanelTabsAtom");
  const {
    createChatPanelTerminalAtom,
    terminalSessionsAtom,
    updateTerminalSessionInfoAtom,
  } = await import("../chatPanelTerminalAtom");
  const {
    activeChatPanelSurfaceAtom,
    chatPanelCreateProjectContextAtom,
    chatPanelCreateTargetAtom,
    chatPanelMaximizedAtom,
    chatPanelNavigateAtom,
    chatPanelStartPageOpenAtom,
    chatPanelSelectedWorkItemAtom,
    CHAT_PANEL_SURFACE_KIND,
    CHAT_PANEL_CREATE_TARGET,
  } = await import("@src/store/ui/chatPanelAtom");
  const {
    WORK_MANAGEMENT_SECTION,
    WORK_MANAGEMENT_PROJECTS_VIEW,
    workManagementProjectsViewAtom,
    workstationTabHeaderAtomByHost,
  } = await import("@src/store/workstation/workstationTabBarAtoms");

  return {
    activateChatPanelTabAtom,
    activeWorkManagementSectionAtom,
    addChatPanelTerminalTabAtom,
    activeChatPanelSurfaceAtom,
    activeSessionIdAtom,
    addChatPanelLaunchpadTabAtom,
    CHAT_PANEL_CREATE_TARGET,
    CHAT_PANEL_SURFACE_KIND,
    chatPanelTabsAtom,
    chatPanelMaximizedAtom,
    chatPanelNavigateAtom,
    chatPanelCreateProjectContextAtom,
    chatPanelCreateTargetAtom,
    chatPanelStartPageOpenAtom,
    closeChatPanelTabAtom,
    closeOtherChatPanelTabsAtom,
    closeProjectOrgChatPanelTabsAtom,
    closeWorkItemChatPanelTabAtom,
    createChatPanelTerminalAtom,
    kanbanDetailPanelVisibleAtom,
    kanbanReplayBoundsAtom,
    kanbanReplayCursorAtom,
    kanbanReplayEventsAtom,
    kanbanReplayModeAtom,
    kanbanReplayPlayingAtom,
    kanbanReplaySpeedAtom,
    kanbanSelectedTaskIdAtom,
    normalizePersistedChatPanelTabsState,
    openOrganizationInChatPanelTabAtom,
    openCreateTargetInChatPanelStartPageAtom,
    openWorkManagementChatPanelTabAtom,
    openOrFocusChatPanelStartPageTabAtom,
    openRuntimeInChatPanelTabAtom,
    openOrFocusSessionInChatPanelTabAtom,
    openOrReplaceSessionInChatPanelTabAtom,
    openProjectInChatPanelTabAtom,
    WORK_MANAGEMENT_SECTION,
    WORK_MANAGEMENT_PROJECTS_VIEW,
    workManagementCreatorVisibleAtom,
    workManagementProjectsViewAtom,
    openSessionInNewChatTabAtom,
    openWorkItemInChatPanelTabAtom,
    prevChatPanelTabAtom,
    setChatPanelTabTitleAtom,
    syncActiveChatPanelTabStateAtom,
    terminalSessionsAtom,
    updateTerminalSessionInfoAtom,
    sessionViewAtom,
    sessionsAtom,
    store,
    chatPanelSelectedWorkItemAtom,
    workstationTabHeaderAtomByHost,
  };
}

describe("closeChatPanelTabAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps a Launchpad fallback when the last tab closes", async () => {
    const {
      activeChatPanelSurfaceAtom,
      CHAT_PANEL_SURFACE_KIND,
      chatPanelTabsAtom,
      chatPanelStartPageOpenAtom,
      closeChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();
    const initialTabId = store.get(chatPanelTabsAtom).activeTabId;
    expect(store.get(chatPanelTabsAtom).tabs[0]).toMatchObject({
      id: initialTabId,
      type: "start-page",
      title: "Launchpad",
    });

    store.set(closeChatPanelTabAtom, initialTabId);

    const fallbackState = store.get(chatPanelTabsAtom);
    expect(fallbackState.tabs).toEqual([
      expect.objectContaining({
        id: fallbackState.activeTabId,
        type: "start-page",
        title: "Launchpad",
      }),
    ]);
    expect(store.get(activeChatPanelSurfaceAtom).kind).toBe(
      CHAT_PANEL_SURFACE_KIND.SESSION
    );
    expect(store.get(chatPanelStartPageOpenAtom)).toBe(true);

    store.set(closeChatPanelTabAtom, fallbackState.activeTabId);
    expect(store.get(chatPanelTabsAtom).tabs).toHaveLength(1);
    expect(store.get(chatPanelTabsAtom).tabs[0].type).toBe("start-page");
  }, 30_000);

  it("releases the pipeline when Launchpad replaces the active session", async () => {
    const {
      activeSessionIdAtom,
      chatPanelTabsAtom,
      closeChatPanelTabAtom,
      openSessionInNewChatTabAtom,
      sessionViewAtom,
      store,
    } = await loadChatPanelTabAtoms();
    const launchpadTabId = store.get(chatPanelTabsAtom).activeTabId;
    const sessionTabId = store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-heavy-replay",
      sessionName: "Heavy replay",
    });

    expect(store.get(activeSessionIdAtom)).toBe("session-heavy-replay");
    store.set(closeChatPanelTabAtom, sessionTabId);

    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(launchpadTabId);
    expect(store.get(activeSessionIdAtom)).toBeNull();
    expect(store.get(sessionViewAtom).activeSessionId).toBeNull();
  });

  it("restores docked presentation when the final management tab closes", async () => {
    const {
      chatPanelMaximizedAtom,
      chatPanelTabsAtom,
      closeChatPanelTabAtom,
      openWorkManagementChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();
    const initialTabId = store.get(chatPanelTabsAtom).activeTabId;
    const managementTabId = store.set(openWorkManagementChatPanelTabAtom, {});

    store.set(closeChatPanelTabAtom, initialTabId);
    store.set(closeChatPanelTabAtom, managementTabId);

    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(store.get(chatPanelTabsAtom).tabs[0].type).toBe("start-page");
  });

  it("releases transient Kanban state when its tab closes", async () => {
    const {
      chatPanelTabsAtom,
      closeChatPanelTabAtom,
      kanbanDetailPanelVisibleAtom,
      kanbanReplayBoundsAtom,
      kanbanReplayCursorAtom,
      kanbanReplayEventsAtom,
      kanbanReplayModeAtom,
      kanbanReplayPlayingAtom,
      kanbanReplaySpeedAtom,
      kanbanSelectedTaskIdAtom,
      openWorkManagementChatPanelTabAtom,
      WORK_MANAGEMENT_PROJECTS_VIEW,
      workManagementCreatorVisibleAtom,
      workManagementProjectsViewAtom,
      store,
      workstationTabHeaderAtomByHost,
    } = await loadChatPanelTabAtoms();
    const workManagementTabId = store.set(
      openWorkManagementChatPanelTabAtom,
      {}
    );
    const retainedEvents = [
      { id: "session-1:created", ts: 1, kind: "created", task: {} },
    ] as unknown as KanbanReplayEvent[];

    store.set(workManagementCreatorVisibleAtom, true);
    store.set(
      workManagementProjectsViewAtom,
      WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS
    );
    store.set(kanbanSelectedTaskIdAtom, "session-1");
    store.set(kanbanDetailPanelVisibleAtom, true);
    store.set(kanbanReplayCursorAtom, 100);
    store.set(kanbanReplayModeAtom, "replay");
    store.set(kanbanReplayBoundsAtom, { start: 1, end: 100 });
    store.set(kanbanReplayEventsAtom, retainedEvents);
    store.set(kanbanReplayPlayingAtom, true);
    store.set(kanbanReplaySpeedAtom, 4);
    store.set(workstationTabHeaderAtomByHost.workManagement, {
      trailing: "retained header",
    });

    store.set(closeChatPanelTabAtom, workManagementTabId);

    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.some((tab) => tab.type === "work-management")
    ).toBe(false);
    expect(store.get(workManagementCreatorVisibleAtom)).toBe(false);
    expect(store.get(workManagementProjectsViewAtom)).toBe(
      WORK_MANAGEMENT_PROJECTS_VIEW.WORK_ITEMS
    );
    expect(store.get(kanbanSelectedTaskIdAtom)).toBeNull();
    expect(store.get(kanbanDetailPanelVisibleAtom)).toBe(false);
    expect(store.get(kanbanReplayCursorAtom)).toBeNull();
    expect(store.get(kanbanReplayModeAtom)).toBe("follow");
    expect(store.get(kanbanReplayBoundsAtom)).toEqual({ start: 0, end: 0 });
    expect(store.get(kanbanReplayEventsAtom)).toEqual([]);
    expect(store.get(kanbanReplayPlayingAtom)).toBe(false);
    expect(store.get(kanbanReplaySpeedAtom)).toBe(1);
    expect(store.get(workstationTabHeaderAtomByHost.workManagement)).toBeNull();
  });

  it("retains shared management state until the last management tab closes", async () => {
    const {
      chatPanelTabsAtom,
      closeChatPanelTabAtom,
      openWorkManagementChatPanelTabAtom,
      store,
      workManagementCreatorVisibleAtom,
      workstationTabHeaderAtomByHost,
      WORK_MANAGEMENT_SECTION,
    } = await loadChatPanelTabAtoms();

    const issuesTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
    });
    const prsTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.GITHUB_PRS,
    });
    store.set(workManagementCreatorVisibleAtom, true);
    store.set(workstationTabHeaderAtomByHost.workManagement, {
      trailing: "retained header",
    });

    store.set(closeChatPanelTabAtom, prsTabId);

    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(issuesTabId);
    expect(store.get(workManagementCreatorVisibleAtom)).toBe(true);
    expect(store.get(workstationTabHeaderAtomByHost.workManagement)).toEqual({
      trailing: "retained header",
    });
  });
});

describe("closeOtherChatPanelTabsAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retains and activates the selected tab while destroying other terminals", async () => {
    const {
      addChatPanelTerminalTabAtom,
      chatPanelTabsAtom,
      closeOtherChatPanelTabsAtom,
      createChatPanelTerminalAtom,
      store,
      terminalSessionsAtom,
    } = await loadChatPanelTabAtoms();
    const retainedTabId = store.get(chatPanelTabsAtom).activeTabId;
    const terminalSessionId = store.set(
      createChatPanelTerminalAtom,
      "Terminal"
    );
    store.set(addChatPanelTerminalTabAtom, terminalSessionId);

    await store.set(closeOtherChatPanelTabsAtom, retainedTabId);

    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      tabs: [{ id: retainedTabId }],
      activeTabId: retainedTabId,
    });
    expect(
      store
        .get(terminalSessionsAtom)
        .some((session) => session.id === terminalSessionId)
    ).toBe(false);
  });
});

describe("closeWorkItemChatPanelTabAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes the tab-owned payload and clears the active selection", async () => {
    const {
      chatPanelSelectedWorkItemAtom,
      chatPanelTabsAtom,
      closeWorkItemChatPanelTabAtom,
      openWorkItemInChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();
    const selectedWorkItem = {
      shortId: "ORG-1",
      projectSlug: "project-one",
      projectId: "project-one",
      projectName: "Project One",
      workItem: {
        session_id: "ORG-1",
        name: "Deleted remotely",
      },
    } as never;

    store.set(openWorkItemInChatPanelTabAtom, selectedWorkItem);
    expect(store.get(chatPanelSelectedWorkItemAtom)).toBe(selectedWorkItem);
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.some((tab) => tab.workItem?.shortId === "ORG-1")
    ).toBe(true);

    store.set(closeWorkItemChatPanelTabAtom, "ORG-1");

    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.some((tab) => tab.workItem?.shortId === "ORG-1")
    ).toBe(false);
    expect(store.get(chatPanelSelectedWorkItemAtom)).toBeNull();
  });
});

describe("closeProjectOrgChatPanelTabsAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes every cached project surface for a revoked org only", async () => {
    const {
      chatPanelTabsAtom,
      closeProjectOrgChatPanelTabsAtom,
      openProjectInChatPanelTabAtom,
      openOrganizationInChatPanelTabAtom,
      openWorkItemInChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();

    store.set(openOrganizationInChatPanelTabAtom, {
      organization: {
        kind: "local",
        projectOrg: {
          orgId: "revoked-org",
          orgName: "Revoked Team",
          orgScope: "project_org",
        },
      },
    });
    store.set(openProjectInChatPanelTabAtom, {
      project: { id: "revoked-project", name: "Revoked Project" },
      projectSlug: "revoked-project",
      orgId: "revoked-org",
      orgName: "Revoked Team",
    } as never);
    store.set(openWorkItemInChatPanelTabAtom, {
      shortId: "REV-1",
      projectSlug: "revoked-project",
      projectId: "revoked-project",
      projectName: "Revoked Project",
      orgId: "revoked-org",
      orgName: "Revoked Team",
      workItem: { session_id: "REV-1", name: "Revoked Item" },
    } as never);
    store.set(openWorkItemInChatPanelTabAtom, {
      shortId: "LIVE-1",
      projectSlug: "live-project",
      projectId: "live-project",
      projectName: "Live Project",
      orgId: "live-org",
      orgName: "Live Team",
      workItem: { session_id: "LIVE-1", name: "Live Item" },
    } as never);

    store.set(closeProjectOrgChatPanelTabsAtom, ["revoked-org"]);

    const tabs = store.get(chatPanelTabsAtom).tabs;
    expect(
      tabs.some(
        (tab) =>
          tab.workItem?.orgId === "revoked-org" ||
          tab.project?.orgId === "revoked-org" ||
          (tab.organization?.kind === "local" &&
            tab.organization.projectOrg.orgId === "revoked-org")
      )
    ).toBe(false);
    expect(tabs.some((tab) => tab.workItem?.shortId === "LIVE-1")).toBe(true);
  });
});

describe("openWorkManagementChatPanelTabAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens Kanban as a singleton default-fullscreen management tab", async () => {
    const {
      chatPanelMaximizedAtom,
      chatPanelTabsAtom,
      activeWorkManagementSectionAtom,
      openWorkManagementChatPanelTabAtom,
      WORK_MANAGEMENT_SECTION,
      store,
    } = await loadChatPanelTabAtoms();

    const firstId = store.set(openWorkManagementChatPanelTabAtom, {});
    const secondId = store.set(openWorkManagementChatPanelTabAtom, {});

    expect(secondId).toBe(firstId);
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.type === "work-management")
    ).toHaveLength(1);
    expect(store.get(chatPanelMaximizedAtom)).toBe(true);
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.KANBAN
    );
  });

  it("keeps a manual Workstation restore while Kanban remains active", async () => {
    const {
      chatPanelMaximizedAtom,
      openWorkManagementChatPanelTabAtom,
      store,
      syncActiveChatPanelTabStateAtom,
    } = await loadChatPanelTabAtoms();

    store.set(openWorkManagementChatPanelTabAtom, {});
    expect(store.get(chatPanelMaximizedAtom)).toBe(true);

    store.set(chatPanelMaximizedAtom, false);
    store.set(syncActiveChatPanelTabStateAtom);

    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
  });

  it("preserves a manual Workstation restore after leaving Kanban", async () => {
    const {
      activateChatPanelTabAtom,
      chatPanelMaximizedAtom,
      chatPanelTabsAtom,
      openWorkManagementChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();
    const primaryTabId = store.get(chatPanelTabsAtom).activeTabId;

    store.set(chatPanelMaximizedAtom, true);
    store.set(openWorkManagementChatPanelTabAtom, {});
    store.set(chatPanelMaximizedAtom, false);
    store.set(activateChatPanelTabAtom, primaryTabId);

    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
  });

  it("opens each management section in a separate tab and focuses it on reselect", async () => {
    const {
      activateChatPanelTabAtom,
      activeChatPanelSurfaceAtom,
      activeWorkManagementSectionAtom,
      addChatPanelLaunchpadTabAtom,
      CHAT_PANEL_SURFACE_KIND,
      chatPanelStartPageOpenAtom,
      chatPanelTabsAtom,
      openWorkManagementChatPanelTabAtom,
      WORK_MANAGEMENT_SECTION,
      store,
    } = await loadChatPanelTabAtoms();

    store.set(addChatPanelLaunchpadTabAtom, "Launchpad");
    expect(store.get(chatPanelStartPageOpenAtom)).toBe(true);

    const workManagementTabId = store.set(
      openWorkManagementChatPanelTabAtom,
      {}
    );
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: workManagementTabId,
      tabs: expect.arrayContaining([
        expect.objectContaining({
          id: workManagementTabId,
          type: "work-management",
          title: "Kanban",
        }),
      ]),
    });
    expect(store.get(chatPanelStartPageOpenAtom)).toBe(false);
    expect(store.get(activeChatPanelSurfaceAtom).kind).toBe(
      CHAT_PANEL_SURFACE_KIND.SESSION
    );
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.KANBAN
    );

    const projectsTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.PROJECTS,
    });
    expect(projectsTabId).not.toBe(workManagementTabId);
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.type === "work-management")
    ).toHaveLength(2);
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.PROJECTS
    );
    expect(
      store.get(chatPanelTabsAtom).tabs.find((tab) => tab.id === projectsTabId)
        ?.title
    ).toBe("Projects");

    const issuesTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
    });
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.GITHUB_ISSUES
    );
    expect(
      store.get(chatPanelTabsAtom).tabs.find((tab) => tab.id === issuesTabId)
        ?.title
    ).toBe("GitHub Issues");

    const prsTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.GITHUB_PRS,
    });
    expect(prsTabId).not.toBe(issuesTabId);
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.GITHUB_PRS
    );
    expect(
      store.get(chatPanelTabsAtom).tabs.find((tab) => tab.id === prsTabId)
        ?.title
    ).toBe("GitHub PRs");
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.type === "work-management")
    ).toHaveLength(4);

    const focusedIssuesTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
    });
    expect(focusedIssuesTabId).toBe(issuesTabId);
    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(issuesTabId);
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.GITHUB_ISSUES
    );

    store.set(activateChatPanelTabAtom, workManagementTabId);
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.KANBAN
    );
  });

  it("restores the prior docked state after leaving a management tab", async () => {
    const {
      activateChatPanelTabAtom,
      chatPanelMaximizedAtom,
      chatPanelTabsAtom,
      openWorkManagementChatPanelTabAtom,
      WORK_MANAGEMENT_SECTION,
      store,
    } = await loadChatPanelTabAtoms();
    const primaryTabId = store.get(chatPanelTabsAtom).activeTabId;

    store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.PROJECTS,
    });
    expect(store.get(chatPanelMaximizedAtom)).toBe(true);

    store.set(activateChatPanelTabAtom, primaryTabId);

    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
  });

  it("preserves a project surface after leaving Work Management", async () => {
    const {
      activeChatPanelSurfaceAtom,
      CHAT_PANEL_SURFACE_KIND,
      chatPanelNavigateAtom,
      chatPanelStartPageOpenAtom,
      openWorkManagementChatPanelTabAtom,
      openOrFocusChatPanelStartPageTabAtom,
      store,
      syncActiveChatPanelTabStateAtom,
      WORK_MANAGEMENT_SECTION,
    } = await loadChatPanelTabAtoms();

    store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.PROJECTS,
    });
    store.set(openOrFocusChatPanelStartPageTabAtom, {});
    store.set(chatPanelNavigateAtom, {
      kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE,
    });

    // Mirrors ChatPanel's layout reconciliation after the active tab changes.
    store.set(syncActiveChatPanelTabStateAtom);

    expect(store.get(chatPanelStartPageOpenAtom)).toBe(false);
    expect(store.get(activeChatPanelSurfaceAtom).kind).toBe(
      CHAT_PANEL_SURFACE_KIND.WORKSPACE_EXPLORE
    );
  });
});

describe("ChatPanel navigation tabs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.removeItem("orgii:chatPanelTabs:v2");
    localStorage.removeItem("orgii-v2-session-view");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens the Work launchpad in a separate tab", async () => {
    const {
      activeChatPanelSurfaceAtom,
      addChatPanelLaunchpadTabAtom,
      CHAT_PANEL_SURFACE_KIND,
      chatPanelTabsAtom,
      chatPanelStartPageOpenAtom,
      openSessionInNewChatTabAtom,
      store,
    } = await loadChatPanelTabAtoms();

    const sessionTabId = store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-current",
      sessionName: "Current session",
    });
    const launchpadTabId = store.set(addChatPanelLaunchpadTabAtom, "Launchpad");

    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: launchpadTabId,
      tabs: expect.arrayContaining([
        expect.objectContaining({
          id: sessionTabId,
          type: "session",
          sessionId: "session-current",
        }),
        expect.objectContaining({
          id: launchpadTabId,
          type: "start-page",
          title: "Launchpad",
        }),
      ]),
    });
    expect(store.get(activeChatPanelSurfaceAtom).kind).toBe(
      CHAT_PANEL_SURFACE_KIND.SESSION
    );
    expect(store.get(chatPanelStartPageOpenAtom)).toBe(true);
  });

  it("opens or focuses a session tab when selected from Launchpad", async () => {
    const {
      addChatPanelLaunchpadTabAtom,
      chatPanelStartPageOpenAtom,
      chatPanelTabsAtom,
      openOrFocusSessionInChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();

    store.set(addChatPanelLaunchpadTabAtom, "Launchpad");
    const sessionTabId = store.set(openOrFocusSessionInChatPanelTabAtom, {
      sessionId: "sidebar-session",
      sessionName: "Sidebar session",
      repoPath: "/tmp/sidebar-session",
    });

    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: sessionTabId,
      tabs: expect.arrayContaining([
        expect.objectContaining({
          id: sessionTabId,
          type: "session",
          sessionId: "sidebar-session",
          title: "Sidebar session",
        }),
      ]),
    });
    expect(store.get(chatPanelStartPageOpenAtom)).toBe(false);

    const focusedTabId = store.set(openOrFocusSessionInChatPanelTabAtom, {
      sessionId: "sidebar-session",
      sessionName: "Sidebar session",
      repoPath: "/tmp/sidebar-session",
    });
    expect(focusedTabId).toBe(sessionTabId);
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.sessionId === "sidebar-session")
    ).toHaveLength(1);
  });

  it("opens Runtime as its own singleton tab without replacing or maximizing other tabs", async () => {
    const {
      chatPanelMaximizedAtom,
      chatPanelTabsAtom,
      openRuntimeInChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();

    const existingTabIds = store
      .get(chatPanelTabsAtom)
      .tabs.map((tab) => tab.id);
    const runtimeTabId = store.set(openRuntimeInChatPanelTabAtom, "Runtime");
    const focusedTabId = store.set(openRuntimeInChatPanelTabAtom, "Runtime");

    expect(focusedTabId).toBe(runtimeTabId);
    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(runtimeTabId);
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(store.get(chatPanelTabsAtom).tabs.map((tab) => tab.id)).toEqual([
      ...existingTabIds,
      runtimeTabId,
    ]);
    expect(
      store.get(chatPanelTabsAtom).tabs.filter((tab) => tab.type === "runtime")
    ).toHaveLength(1);
  });

  it("opens org management in its own singleton tab and restores the selected org", async () => {
    const {
      activateChatPanelTabAtom,
      activeChatPanelSurfaceAtom,
      CHAT_PANEL_SURFACE_KIND,
      chatPanelTabsAtom,
      openOrganizationInChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();
    const launchpadTabId = store.get(chatPanelTabsAtom).activeTabId;

    const managementTabId = store.set(openOrganizationInChatPanelTabAtom, {
      organization: { kind: "cloud", cloudOrg: { orgId: "org-a" } },
      title: "Manage ORG",
    });

    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: managementTabId,
      tabs: expect.arrayContaining([
        expect.objectContaining({
          id: managementTabId,
          type: "organization",
          title: "Manage ORG",
          organization: {
            kind: "cloud",
            cloudOrg: { orgId: "org-a" },
          },
        }),
      ]),
    });
    expect(store.get(activeChatPanelSurfaceAtom)).toEqual({
      kind: CHAT_PANEL_SURFACE_KIND.CLOUD_ORG,
      cloudOrg: { orgId: "org-a" },
    });

    const switchedTabId = store.set(openOrganizationInChatPanelTabAtom, {
      organization: {
        kind: "local",
        projectOrg: {
          orgId: "local-b",
          orgName: "Local B",
          orgScope: "project_org",
        },
      },
      title: "Manage ORG",
    });
    expect(switchedTabId).toBe(managementTabId);
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.type === "organization")
    ).toEqual([
      expect.objectContaining({
        organization: {
          kind: "local",
          projectOrg: expect.objectContaining({ orgId: "local-b" }),
        },
      }),
    ]);

    store.set(activateChatPanelTabAtom, launchpadTabId);
    store.set(activateChatPanelTabAtom, managementTabId);
    expect(store.get(activeChatPanelSurfaceAtom)).toEqual({
      kind: CHAT_PANEL_SURFACE_KIND.PROJECT_ORG,
      projectOrg: expect.objectContaining({ orgId: "local-b" }),
    });
  });

  it("reuses the singleton start page instead of stacking new-session tabs", async () => {
    const {
      chatPanelTabsAtom,
      openOrFocusChatPanelStartPageTabAtom,
      openSessionInNewChatTabAtom,
      store,
    } = await loadChatPanelTabAtoms();
    const launchpadTabId = store.get(chatPanelTabsAtom).activeTabId;

    // Move focus onto a session tab, then invoke the new-session entry point
    // repeatedly. Each call must focus the original start page, never add one.
    store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-a",
      sessionName: "Session A",
    });

    const firstId = store.set(openOrFocusChatPanelStartPageTabAtom, {
      title: "Launchpad",
    });
    const secondId = store.set(openOrFocusChatPanelStartPageTabAtom, {
      title: "Launchpad",
    });

    expect(firstId).toBe(launchpadTabId);
    expect(secondId).toBe(launchpadTabId);
    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(launchpadTabId);
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.type === "start-page")
    ).toHaveLength(1);
  });

  it("opens creator targets inside the singleton start page", async () => {
    const {
      CHAT_PANEL_CREATE_TARGET,
      chatPanelCreateProjectContextAtom,
      chatPanelCreateTargetAtom,
      chatPanelStartPageOpenAtom,
      chatPanelTabsAtom,
      openCreateTargetInChatPanelStartPageAtom,
      openSessionInNewChatTabAtom,
      store,
    } = await loadChatPanelTabAtoms();
    const launchpadTabId = store.get(chatPanelTabsAtom).activeTabId;

    store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-a",
      sessionName: "Session A",
    });
    const openedTabId = store.set(openCreateTargetInChatPanelStartPageAtom, {
      target: CHAT_PANEL_CREATE_TARGET.COLLAB_ORG,
      title: "Launchpad",
      createProjectContext: {
        orgId: "org-a",
        scopeBreadcrumbLabel: "ORG A",
      },
    });

    expect(openedTabId).toBe(launchpadTabId);
    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(launchpadTabId);
    expect(store.get(chatPanelCreateTargetAtom)).toBe(
      CHAT_PANEL_CREATE_TARGET.COLLAB_ORG
    );
    expect(store.get(chatPanelCreateProjectContextAtom)).toEqual({
      orgId: "org-a",
      scopeBreadcrumbLabel: "ORG A",
    });
    expect(store.get(chatPanelStartPageOpenAtom)).toBe(true);
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.type === "start-page")
    ).toHaveLength(1);
  });

  it("collapses persisted duplicate start-page tabs into one", async () => {
    const { normalizePersistedChatPanelTabsState } =
      await loadChatPanelTabAtoms();

    const normalized = normalizePersistedChatPanelTabsState({
      activeTabId: "start-b",
      tabs: [
        { id: "start-a", type: "start-page", title: "Launchpad" },
        { id: "start-b", type: "start-page", title: "Launchpad" },
        { id: "session-a", type: "session", title: "Chat", sessionId: "s1" },
      ],
    });

    expect(
      normalized?.tabs.filter((tab) => tab.type === "start-page")
    ).toHaveLength(1);
    // The active start-page tab is the one that survives.
    expect(normalized?.tabs.find((tab) => tab.type === "start-page")?.id).toBe(
      "start-b"
    );
    expect(normalized?.activeTabId).toBe("start-b");
  });

  it("migrates cloud and local org tabs into the active shared organization tab", async () => {
    const { normalizePersistedChatPanelTabsState } =
      await loadChatPanelTabAtoms();

    const normalized = normalizePersistedChatPanelTabsState({
      activeTabId: "local-org",
      tabs: [
        {
          id: "cloud-org",
          type: "cloud-org",
          title: "Manage ORG",
          cloudOrg: { orgId: "cloud-a" },
        },
        {
          id: "local-org",
          type: "project-org",
          title: "Local A",
          projectOrg: {
            orgId: "local-a",
            orgName: "Local A",
            orgScope: "project_org",
          },
        },
      ],
    });

    expect(normalized).toMatchObject({
      activeTabId: "chat-organization-management",
      tabs: [
        {
          id: "chat-organization-management",
          type: "organization",
          organization: {
            kind: "local",
            projectOrg: { orgId: "local-a" },
          },
        },
      ],
    });
  });

  it("keeps one persisted management tab per sidebar section", async () => {
    const { normalizePersistedChatPanelTabsState, WORK_MANAGEMENT_SECTION } =
      await loadChatPanelTabAtoms();

    const normalized = normalizePersistedChatPanelTabsState({
      activeTabId: "issues-b",
      tabs: [
        { id: "start", type: "start-page", title: "Launchpad" },
        {
          id: "issues-a",
          type: "work-management",
          title: "GitHub Issues",
          managementSection: WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
        },
        {
          id: "issues-b",
          type: "work-management",
          title: "GitHub Issues",
          managementSection: WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
        },
        {
          id: "prs",
          type: "work-management",
          title: "GitHub PRs",
          managementSection: WORK_MANAGEMENT_SECTION.GITHUB_PRS,
        },
      ],
    });

    expect(
      normalized?.tabs.filter((tab) => tab.type === "work-management")
    ).toHaveLength(2);
    expect(normalized?.tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "issues-b" }),
        expect.objectContaining({ id: "prs" }),
      ])
    );
    expect(normalized?.activeTabId).toBe("issues-b");
  });

  it("collapses persisted duplicate Runtime tabs into one", async () => {
    const { normalizePersistedChatPanelTabsState } =
      await loadChatPanelTabAtoms();

    const normalized = normalizePersistedChatPanelTabsState({
      activeTabId: "runtime-b",
      tabs: [
        { id: "start", type: "start-page", title: "Launchpad" },
        { id: "runtime-a", type: "runtime", title: "Runtime" },
        { id: "runtime-b", type: "runtime", title: "Runtime" },
      ],
    });

    expect(
      normalized?.tabs.filter((tab) => tab.type === "runtime")
    ).toHaveLength(1);
    expect(normalized?.activeTabId).toBe("runtime-b");
  });

  it("migrates persisted legacy Launchpad tabs to the start page", async () => {
    const { normalizePersistedChatPanelTabsState } =
      await loadChatPanelTabAtoms();

    expect(
      normalizePersistedChatPanelTabsState({
        activeTabId: "legacy-launchpad",
        tabs: [
          {
            id: "legacy-launchpad",
            type: "launchpad",
            title: "Launchpad",
            createdAt: "2026-07-12T00:00:00.000Z",
            updatedAt: "2026-07-12T00:00:00.000Z",
          },
        ],
      })
    ).toMatchObject({
      activeTabId: "legacy-launchpad",
      tabs: [
        expect.objectContaining({
          id: "legacy-launchpad",
          type: "start-page",
          title: "Launchpad",
        }),
      ],
    });
  });

  it("consolidates persisted Dashboard tabs into Launchpad", async () => {
    const { normalizePersistedChatPanelTabsState } =
      await loadChatPanelTabAtoms();

    expect(
      normalizePersistedChatPanelTabsState({
        activeTabId: "dashboard",
        tabs: [{ id: "dashboard", type: "dashboard", title: "Dashboard" }],
      })
    ).toMatchObject({
      activeTabId: "dashboard",
      tabs: [
        expect.objectContaining({
          id: "dashboard",
          type: "start-page",
          title: "Launchpad",
        }),
      ],
    });
  });

  it("migrates empty conversation tabs to Launchpad", async () => {
    const { normalizePersistedChatPanelTabsState } =
      await loadChatPanelTabAtoms();

    expect(
      normalizePersistedChatPanelTabsState({
        activeTabId: "empty-chat",
        tabs: [
          {
            id: "empty-chat",
            type: "session",
            title: "Chat",
            sessionId: null,
          },
        ],
      })
    ).toMatchObject({
      activeTabId: "empty-chat",
      tabs: [
        expect.objectContaining({
          id: "empty-chat",
          type: "start-page",
          title: "Launchpad",
        }),
      ],
    });
  });
});

describe("openSessionInNewChatTabAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.removeItem("orgii:chatPanelTabs:v2");
    localStorage.removeItem("orgii-v2-session-view");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens a linked tab and switches the WorkStation session", async () => {
    const {
      activeSessionIdAtom,
      chatPanelTabsAtom,
      openSessionInNewChatTabAtom,
      sessionViewAtom,
      store,
    } = await loadChatPanelTabAtoms();

    const tabId = store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-target",
      sessionName: "Target session",
      repoPath: "/repos/orgii",
    });

    const tabsState = store.get(chatPanelTabsAtom);
    const sessionView = store.get(sessionViewAtom);

    expect(tabsState.activeTabId).toBe(tabId);
    expect(tabsState.tabs.at(-1)).toMatchObject({
      id: tabId,
      type: "session",
      sessionId: "session-target",
    });
    expect(sessionView).toMatchObject({
      activeSessionId: "session-target",
      sessionName: "Target session",
      repoPath: "/repos/orgii",
    });
    expect(store.get(activeSessionIdAtom)).toBe("session-target");
  });

  it("activates a linked session tab through the shared activation action", async () => {
    const {
      activateChatPanelTabAtom,
      activeSessionIdAtom,
      openSessionInNewChatTabAtom,
      sessionViewAtom,
      sessionsAtom,
      store,
    } = await loadChatPanelTabAtoms();

    store.set(sessionsAtom, [
      makeSession("session-a", {
        name: "Session A",
        repoPath: "/repos/a",
      }),
      makeSession("session-b", {
        name: "Session B",
        repoPath: "/repos/b",
      }),
    ]);
    const firstTabId = store.set(openSessionInNewChatTabAtom, "session-a");
    store.set(openSessionInNewChatTabAtom, "session-b");

    store.set(activateChatPanelTabAtom, firstTabId);

    expect(store.get(activeSessionIdAtom)).toBe("session-a");
    expect(store.get(sessionViewAtom)).toMatchObject({
      activeSessionId: "session-a",
      sessionName: "Session A",
      repoPath: "/repos/a",
    });
  });

  it("uses the shared activation path for previous-tab navigation", async () => {
    const {
      activeSessionIdAtom,
      openSessionInNewChatTabAtom,
      prevChatPanelTabAtom,
      sessionsAtom,
      store,
    } = await loadChatPanelTabAtoms();

    store.set(sessionsAtom, [
      makeSession("session-a", { name: "Session A", repoPath: "/repos/a" }),
      makeSession("session-b", { name: "Session B", repoPath: "/repos/b" }),
    ]);
    store.set(openSessionInNewChatTabAtom, "session-a");
    store.set(openSessionInNewChatTabAtom, "session-b");

    store.set(prevChatPanelTabAtom);

    expect(store.get(activeSessionIdAtom)).toBe("session-a");
  });

  it("uses the shared activation path after closing the active tab", async () => {
    const {
      activeSessionIdAtom,
      closeChatPanelTabAtom,
      openSessionInNewChatTabAtom,
      sessionsAtom,
      store,
    } = await loadChatPanelTabAtoms();

    store.set(sessionsAtom, [
      makeSession("session-a", { name: "Session A", repoPath: "/repos/a" }),
      makeSession("session-b", { name: "Session B", repoPath: "/repos/b" }),
    ]);
    store.set(openSessionInNewChatTabAtom, "session-a");
    const secondTabId = store.set(openSessionInNewChatTabAtom, "session-b");

    store.set(closeChatPanelTabAtom, secondTabId);

    expect(store.get(activeSessionIdAtom)).toBe("session-a");
  });
});

describe("openOrReplaceSessionInChatPanelTabAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.removeItem("orgii:chatPanelTabs:v2");
    localStorage.removeItem("orgii-v2-session-view");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("reuses the active session tab for normal sidebar navigation", async () => {
    const {
      activeSessionIdAtom,
      chatPanelTabsAtom,
      openOrReplaceSessionInChatPanelTabAtom,
      openSessionInNewChatTabAtom,
      store,
    } = await loadChatPanelTabAtoms();

    const originalTabId = store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-a",
      sessionName: "Session A",
    });
    const originalTabCount = store.get(chatPanelTabsAtom).tabs.length;

    const replacementTabId = store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-b",
      sessionName: "Session B",
      repoPath: "/repos/b",
    });

    expect(replacementTabId).toBe(originalTabId);
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: originalTabId,
      tabs: expect.arrayContaining([
        expect.objectContaining({
          id: originalTabId,
          type: "session",
          title: "Session B",
          sessionId: "session-b",
        }),
      ]),
    });
    expect(store.get(chatPanelTabsAtom).tabs).toHaveLength(originalTabCount);
    expect(store.get(activeSessionIdAtom)).toBe("session-b");
  });

  it("does not replace a non-session tab", async () => {
    const { chatPanelTabsAtom, openOrReplaceSessionInChatPanelTabAtom, store } =
      await loadChatPanelTabAtoms();

    const launchpadTabId = store.get(chatPanelTabsAtom).activeTabId;
    const sessionTabId = store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-a",
      sessionName: "Session A",
    });

    expect(sessionTabId).not.toBe(launchpadTabId);
    expect(store.get(chatPanelTabsAtom).tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: launchpadTabId, type: "start-page" }),
        expect.objectContaining({
          id: sessionTabId,
          type: "session",
          sessionId: "session-a",
        }),
      ])
    );
  });
});

describe("managed TUI terminal state", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the PTY environment reference across terminal metadata updates", async () => {
    const {
      createChatPanelTerminalAtom,
      store,
      terminalSessionsAtom,
      updateTerminalSessionInfoAtom,
    } = await loadChatPanelTabAtoms();
    const terminalId = store.set(createChatPanelTerminalAtom, {
      name: "Codex",
      agentCommand: "codex",
      agentSessionId: "managed-session",
    });
    const initialSession = store
      .get(terminalSessionsAtom)
      .find((session) => session.id === terminalId);

    store.set(updateTerminalSessionInfoAtom, {
      sessionId: terminalId,
      info: { processName: "codex" },
    });

    const updatedSession = store
      .get(terminalSessionsAtom)
      .find((session) => session.id === terminalId);
    expect(updatedSession?.envOverride).toBe(initialSession?.envOverride);
    expect(updatedSession?.envOverride).toEqual({
      ORGII_SESSION_ID: "managed-session",
    });
  });
});

describe("setChatPanelTabTitleAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not write tab state when the title is unchanged", async () => {
    const { chatPanelTabsAtom, setChatPanelTabTitleAtom, store } =
      await loadChatPanelTabAtoms();
    const stateBefore = store.get(chatPanelTabsAtom);
    const activeTab = stateBefore.tabs.find(
      (tab) => tab.id === stateBefore.activeTabId
    );
    expect(activeTab).toBeDefined();

    store.set(setChatPanelTabTitleAtom, {
      tabId: stateBefore.activeTabId,
      title: activeTab?.title ?? "",
    });

    expect(store.get(chatPanelTabsAtom)).toBe(stateBefore);
  });
});
