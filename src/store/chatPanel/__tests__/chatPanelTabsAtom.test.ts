import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sessionsAtom } from "@src/store/session/sessionAtom";
import type { Session } from "@src/store/session/sessionAtom/types";
import {
  activeSessionIdAtom,
  sessionViewAtom,
} from "@src/store/session/viewAtom";
import {
  CHAT_PANEL_CREATE_TARGET,
  CHAT_PANEL_SURFACE_KIND,
  activeChatPanelSurfaceAtom,
  chatPanelCreateProjectContextAtom,
  chatPanelCreateTargetAtom,
  chatPanelMaximizedAtom,
  chatPanelNavigateAtom,
  chatPanelSelectedWorkItemAtom,
  chatPanelStartPageOpenAtom,
} from "@src/store/ui/chatPanelAtom";
import {
  kanbanDetailPanelVisibleAtom,
  kanbanSelectedTaskIdAtom,
} from "@src/store/ui/kanbanViewStateAtom";
import { workManagementCreatorVisibleAtom } from "@src/store/ui/workManagementCreatorAtom";
import {
  WORK_MANAGEMENT_PROJECTS_VIEW,
  WORK_MANAGEMENT_SECTION,
  workManagementProjectsViewAtom,
  workstationTabHeaderAtomByHost,
} from "@src/store/workstation/workstationTabBarAtoms";
import {
  createInstrumentedStore,
  resetInstrumentedStore,
} from "@src/util/core/state/instrumentedStore";

import {
  activateChatPanelTabAtom,
  activeChatPanelTabAtom,
  activeWorkManagementSectionAtom,
  addChatPanelLaunchpadTabAtom,
  addChatPanelTerminalTabAtom,
  chatPanelTabsAtom,
  closeChatPanelTabAtom,
  closeOtherChatPanelTabsAtom,
  closeOtherThanActiveChatPanelTabsAtom,
  closeProjectOrgChatPanelTabsAtom,
  closeWorkItemChatPanelTabAtom,
  isChatPanelTabStationAvailable,
  normalizePersistedChatPanelTabsState,
  openCreateTargetInChatPanelStartPageAtom,
  openGitHubIssueInChatPanelTabAtom,
  openGitHubPrInChatPanelTabAtom,
  openOrFocusChatPanelStartPageTabAtom,
  openOrFocusSessionInChatPanelTabAtom,
  openOrReplaceSessionInChatPanelTabAtom,
  openOrganizationInChatPanelTabAtom,
  openProjectInChatPanelTabAtom,
  openRuntimeInChatPanelTabAtom,
  openSessionInNewChatTabAtom,
  openTeamInboxInChatPanelTabAtom,
  openWorkItemInChatPanelTabAtom,
  openWorkManagementChatPanelTabAtom,
  prevChatPanelTabAtom,
  resolveChatPanelMaximizedForLayout,
  setActiveWorkManagementSectionAtom,
  setChatPanelTabTitleAtom,
  syncActiveChatPanelTabStateAtom,
  toggleActiveChatPanelMaximizedAtom,
} from "../chatPanelTabsAtom";
import {
  createChatPanelTerminalAtom,
  terminalSessionsAtom,
  updateTerminalSessionInfoAtom,
} from "../chatPanelTerminalAtom";

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
  const store = createInstrumentedStore();

  return {
    activateChatPanelTabAtom,
    activeChatPanelTabAtom,
    activeWorkManagementSectionAtom,
    addChatPanelTerminalTabAtom,
    activeChatPanelSurfaceAtom,
    activeSessionIdAtom,
    addChatPanelLaunchpadTabAtom,
    CHAT_PANEL_CREATE_TARGET,
    CHAT_PANEL_SURFACE_KIND,
    chatPanelTabsAtom,
    isChatPanelTabStationAvailable,
    chatPanelMaximizedAtom,
    chatPanelNavigateAtom,
    chatPanelCreateProjectContextAtom,
    chatPanelCreateTargetAtom,
    chatPanelStartPageOpenAtom,
    closeChatPanelTabAtom,
    closeOtherChatPanelTabsAtom,
    closeOtherThanActiveChatPanelTabsAtom,
    closeProjectOrgChatPanelTabsAtom,
    closeWorkItemChatPanelTabAtom,
    createChatPanelTerminalAtom,
    kanbanDetailPanelVisibleAtom,
    kanbanSelectedTaskIdAtom,
    normalizePersistedChatPanelTabsState,
    openOrganizationInChatPanelTabAtom,
    openCreateTargetInChatPanelStartPageAtom,
    openGitHubIssueInChatPanelTabAtom,
    openGitHubPrInChatPanelTabAtom,
    openWorkManagementChatPanelTabAtom,
    openOrFocusChatPanelStartPageTabAtom,
    openRuntimeInChatPanelTabAtom,
    openTeamInboxInChatPanelTabAtom,
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
    setActiveWorkManagementSectionAtom,
    setChatPanelTabTitleAtom,
    resolveChatPanelMaximizedForLayout,
    syncActiveChatPanelTabStateAtom,
    toggleActiveChatPanelMaximizedAtom,
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
    resetInstrumentedStore();
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
    store.set(workManagementCreatorVisibleAtom, true);
    store.set(
      workManagementProjectsViewAtom,
      WORK_MANAGEMENT_PROJECTS_VIEW.PROJECTS
    );
    store.set(kanbanSelectedTaskIdAtom, "session-1");
    store.set(kanbanDetailPanelVisibleAtom, true);
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
    const kanbanTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.KANBAN,
    });
    store.set(workManagementCreatorVisibleAtom, true);
    store.set(workstationTabHeaderAtomByHost.workManagement, {
      trailing: "retained header",
    });

    store.set(closeChatPanelTabAtom, kanbanTabId);

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
    resetInstrumentedStore();
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

  it("lets sidebar navigation retain only the newly active destination", async () => {
    const {
      chatPanelTabsAtom,
      closeOtherThanActiveChatPanelTabsAtom,
      openTeamInboxInChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();

    const inboxTabId = store.set(openTeamInboxInChatPanelTabAtom, "Inbox");
    expect(store.get(chatPanelTabsAtom).tabs).toHaveLength(2);

    await store.set(closeOtherThanActiveChatPanelTabsAtom);

    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      tabs: [
        {
          id: inboxTabId,
          type: "work-management",
          managementSection: WORK_MANAGEMENT_SECTION.INBOX,
        },
      ],
      activeTabId: inboxTabId,
    });
  });
});

describe("closeWorkItemChatPanelTabAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInstrumentedStore();
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

    store.set(closeWorkItemChatPanelTabAtom, selectedWorkItem);

    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.some((tab) => tab.workItem?.shortId === "ORG-1")
    ).toBe(false);
    expect(store.get(chatPanelSelectedWorkItemAtom)).toBeNull();
  });

  it("keeps identical standalone short IDs isolated by organization", async () => {
    const { chatPanelTabsAtom, openWorkItemInChatPanelTabAtom, store } =
      await loadChatPanelTabAtoms();
    const personal = {
      shortId: "WI-0001",
      orgId: "personal-org",
      projectSlug: "",
      projectId: "",
      projectName: "Standalone Work Items",
      workItem: { session_id: "personal-row", name: "Personal item" },
    };
    const cloud = {
      ...personal,
      orgId: "cloud-org",
      workItem: { session_id: "cloud-row", name: "Cloud item" },
    };

    store.set(openWorkItemInChatPanelTabAtom, personal as never);
    store.set(openWorkItemInChatPanelTabAtom, cloud as never);

    const workItemTabs = store
      .get(chatPanelTabsAtom)
      .tabs.filter((tab) => tab.type === "work-item");
    expect(workItemTabs).toHaveLength(2);
    expect(workItemTabs.map((tab) => tab.workItem?.orgId).sort()).toEqual([
      "cloud-org",
      "personal-org",
    ]);
  });

  it("restores a session's split Station layout after visiting a work item", async () => {
    const {
      activateChatPanelTabAtom,
      activeChatPanelTabAtom,
      chatPanelMaximizedAtom,
      isChatPanelTabStationAvailable,
      openSessionInNewChatTabAtom,
      openWorkItemInChatPanelTabAtom,
      resolveChatPanelMaximizedForLayout,
      store,
    } = await loadChatPanelTabAtoms();
    const sessionTabId = store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-with-station",
      sessionName: "Session with Station",
    });
    store.set(chatPanelMaximizedAtom, false);

    store.set(openWorkItemInChatPanelTabAtom, {
      shortId: "ORG-2",
      projectSlug: "project-one",
      projectId: "project-one",
      projectName: "Project One",
      workItem: {
        session_id: "ORG-2",
        name: "Full-screen work item",
      },
    } as never);

    expect(
      isChatPanelTabStationAvailable(store.get(activeChatPanelTabAtom))
    ).toBe(false);
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(
      resolveChatPanelMaximizedForLayout(
        store.get(chatPanelMaximizedAtom),
        store.get(activeChatPanelTabAtom)
      )
    ).toBe(true);

    store.set(activateChatPanelTabAtom, sessionTabId);

    expect(
      isChatPanelTabStationAvailable(store.get(activeChatPanelTabAtom))
    ).toBe(true);
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
  });
});

describe("closeProjectOrgChatPanelTabsAtom", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInstrumentedStore();
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
    resetInstrumentedStore();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens Kanban as a singleton Station-excluded tab", async () => {
    const {
      activeChatPanelTabAtom,
      chatPanelMaximizedAtom,
      chatPanelTabsAtom,
      activeWorkManagementSectionAtom,
      isChatPanelTabStationAvailable,
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
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(
      isChatPanelTabStationAvailable(store.get(activeChatPanelTabAtom))
    ).toBe(false);
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.KANBAN
    );
  });

  it("keeps the Station toggle disabled for Kanban", async () => {
    const {
      activeChatPanelTabAtom,
      chatPanelMaximizedAtom,
      isChatPanelTabStationAvailable,
      openWorkManagementChatPanelTabAtom,
      resolveChatPanelMaximizedForLayout,
      store,
      syncActiveChatPanelTabStateAtom,
      toggleActiveChatPanelMaximizedAtom,
    } = await loadChatPanelTabAtoms();

    store.set(openWorkManagementChatPanelTabAtom, {});
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);

    expect(
      isChatPanelTabStationAvailable(store.get(activeChatPanelTabAtom))
    ).toBe(false);
    expect(store.set(toggleActiveChatPanelMaximizedAtom)).toBe(false);
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);

    // Reconciliation leaves the user's preference untouched; the effective
    // layout remains full-screen while Kanban owns the workbench.
    store.set(syncActiveChatPanelTabStateAtom);
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(
      resolveChatPanelMaximizedForLayout(
        store.get(chatPanelMaximizedAtom),
        store.get(activeChatPanelTabAtom)
      )
    ).toBe(true);

    expect(store.set(toggleActiveChatPanelMaximizedAtom)).toBe(false);
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
  });

  it("restores the session's prior full-screen state after leaving Kanban", async () => {
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
    store.set(activateChatPanelTabAtom, primaryTabId);

    expect(store.get(chatPanelMaximizedAtom)).toBe(true);
  });

  it("keeps Kanban separate while reusing one tab for every Work dataset", async () => {
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
    expect(issuesTabId).toBe(projectsTabId);
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
    expect(prsTabId).toBe(issuesTabId);
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
    ).toHaveLength(2);

    const focusedIssuesTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
    });
    expect(focusedIssuesTabId).toBe(projectsTabId);
    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(issuesTabId);
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.GITHUB_ISSUES
    );

    store.set(activateChatPanelTabAtom, workManagementTabId);
    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.KANBAN
    );
  });

  it("switches the active Work tab dataset without opening another tab", async () => {
    const {
      activeWorkManagementSectionAtom,
      chatPanelTabsAtom,
      openWorkManagementChatPanelTabAtom,
      setActiveWorkManagementSectionAtom,
      WORK_MANAGEMENT_SECTION,
      store,
    } = await loadChatPanelTabAtoms();

    const workTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.PROJECTS,
      title: "Work Items",
    });
    store.set(setActiveWorkManagementSectionAtom, {
      section: WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
      title: "Work Items",
    });

    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.GITHUB_ISSUES
    );
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.type === "work-management")
    ).toHaveLength(1);
    expect(
      store.get(chatPanelTabsAtom).tabs.find((tab) => tab.id === workTabId)
    ).toMatchObject({
      managementSection: WORK_MANAGEMENT_SECTION.GITHUB_ISSUES,
      title: "Work Items",
    });
  });

  it("projects an already-open legacy Inbox tab through the shared Work surface", async () => {
    const {
      activeWorkManagementSectionAtom,
      chatPanelTabsAtom,
      setActiveWorkManagementSectionAtom,
      store,
      WORK_MANAGEMENT_SECTION,
    } = await loadChatPanelTabAtoms();
    const legacyInboxTabId = "chat-team-inbox";
    store.set(chatPanelTabsAtom, {
      tabs: [
        {
          id: legacyInboxTabId,
          type: "team-inbox",
          title: "Inbox",
        },
      ],
      activeTabId: legacyInboxTabId,
    });

    expect(store.get(activeWorkManagementSectionAtom)).toBe(
      WORK_MANAGEMENT_SECTION.INBOX
    );

    store.set(setActiveWorkManagementSectionAtom, {
      section: WORK_MANAGEMENT_SECTION.GITHUB_PRS,
      title: "Work Items",
    });

    expect(store.get(chatPanelTabsAtom).tabs).toEqual([
      expect.objectContaining({
        id: legacyInboxTabId,
        type: "work-management",
        title: "Work Items",
        managementSection: WORK_MANAGEMENT_SECTION.GITHUB_PRS,
      }),
    ]);
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
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);

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
    resetInstrumentedStore();
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

  it("opens Runtime as its own singleton Station-excluded tab", async () => {
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

  it("opens Team Inbox through the shared Work list tab", async () => {
    const {
      chatPanelMaximizedAtom,
      chatPanelTabsAtom,
      openTeamInboxInChatPanelTabAtom,
      openWorkManagementChatPanelTabAtom,
      store,
      WORK_MANAGEMENT_SECTION,
    } = await loadChatPanelTabAtoms();

    const workTabId = store.set(openWorkManagementChatPanelTabAtom, {
      section: WORK_MANAGEMENT_SECTION.PROJECTS,
      title: "Projects",
    });
    const teamInboxTabId = store.set(
      openTeamInboxInChatPanelTabAtom,
      "Team Inbox"
    );
    const focusedTabId = store.set(openTeamInboxInChatPanelTabAtom, "Inbox");

    expect(teamInboxTabId).toBe(workTabId);
    expect(focusedTabId).toBe(teamInboxTabId);
    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(teamInboxTabId);
    expect(store.get(chatPanelMaximizedAtom)).toBe(false);
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.type === "work-management")
    ).toEqual([
      expect.objectContaining({
        id: teamInboxTabId,
        title: "Inbox",
        managementSection: WORK_MANAGEMENT_SECTION.INBOX,
      }),
    ]);
    expect(
      store.get(chatPanelTabsAtom).tabs.some((tab) => tab.type === "team-inbox")
    ).toBe(false);
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
      organization: {
        kind: "cloud",
        cloudOrg: {
          orgId: "org-a",
          initialView: "members",
          initialViewRequestId: 1,
        },
      },
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
            cloudOrg: {
              orgId: "org-a",
              initialView: "members",
              initialViewRequestId: 1,
            },
          },
        }),
      ]),
    });
    expect(store.get(activeChatPanelSurfaceAtom)).toEqual({
      kind: CHAT_PANEL_SURFACE_KIND.CLOUD_ORG,
      cloudOrg: {
        orgId: "org-a",
        initialView: "members",
        initialViewRequestId: 1,
      },
    });

    const refocusedTabId = store.set(openOrganizationInChatPanelTabAtom, {
      organization: {
        kind: "cloud",
        cloudOrg: {
          orgId: "org-a",
          initialView: "members",
          initialViewRequestId: 2,
        },
      },
      title: "Manage ORG",
    });
    expect(refocusedTabId).toBe(managementTabId);
    expect(store.get(activeChatPanelSurfaceAtom)).toEqual({
      kind: CHAT_PANEL_SURFACE_KIND.CLOUD_ORG,
      cloudOrg: {
        orgId: "org-a",
        initialView: "members",
        initialViewRequestId: 2,
      },
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
      target: CHAT_PANEL_CREATE_TARGET.PROJECT,
      title: "Launchpad",
      createProjectContext: {
        orgId: "org-a",
        scopeBreadcrumbLabel: "ORG A",
      },
    });

    expect(openedTabId).toBe(launchpadTabId);
    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(launchpadTabId);
    expect(store.get(chatPanelCreateTargetAtom)).toBe(
      CHAT_PANEL_CREATE_TARGET.PROJECT
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

  it("keeps the Work Item creator selected after switching back to Launchpad", async () => {
    const {
      CHAT_PANEL_CREATE_TARGET,
      chatPanelCreateTargetAtom,
      chatPanelStartPageOpenAtom,
      chatPanelTabsAtom,
      openCreateTargetInChatPanelStartPageAtom,
      openSessionInNewChatTabAtom,
      store,
      syncActiveChatPanelTabStateAtom,
    } = await loadChatPanelTabAtoms();
    const launchpadTabId = store.get(chatPanelTabsAtom).activeTabId;

    store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-a",
      sessionName: "Session A",
    });
    store.set(openCreateTargetInChatPanelStartPageAtom, {
      target: CHAT_PANEL_CREATE_TARGET.WORK_ITEM,
    });

    // Mirrors ChatPanel's layout effect after the active tab changes from the
    // session back to Launchpad.
    store.set(syncActiveChatPanelTabStateAtom);

    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(launchpadTabId);
    expect(store.get(chatPanelStartPageOpenAtom)).toBe(true);
    expect(store.get(chatPanelCreateTargetAtom)).toBe(
      CHAT_PANEL_CREATE_TARGET.WORK_ITEM
    );
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

  it("collapses persisted list sections into one Work tab", async () => {
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
    ).toHaveLength(1);
    expect(normalized?.tabs).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "issues-b" })])
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

  it("drops retired persisted surface types", async () => {
    const { normalizePersistedChatPanelTabsState } =
      await loadChatPanelTabAtoms();

    expect(
      normalizePersistedChatPanelTabsState({
        activeTabId: "retired-changelog",
        tabs: [
          { id: "start", type: "start-page", title: "Launchpad" },
          {
            id: "retired-changelog",
            type: "changelog",
            title: "Changelog",
          },
        ],
      })
    ).toEqual({
      activeTabId: "start",
      tabs: [{ id: "start", type: "start-page", title: "Launchpad" }],
    });
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
    resetInstrumentedStore();
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
    resetInstrumentedStore();
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

  it("consumes the active Launchpad tab instead of stacking behind it", async () => {
    const {
      activeSessionIdAtom,
      chatPanelStartPageOpenAtom,
      chatPanelTabsAtom,
      openOrReplaceSessionInChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();

    const launchpadTabId = store.get(chatPanelTabsAtom).activeTabId;
    const sessionTabId = store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-a",
      sessionName: "Session A",
      repoPath: "/repos/a",
    });

    expect(sessionTabId).not.toBe(launchpadTabId);
    expect(store.get(chatPanelTabsAtom)).toMatchObject({
      activeTabId: sessionTabId,
      tabs: [
        {
          id: sessionTabId,
          type: "session",
          title: "Session A",
          sessionId: "session-a",
        },
      ],
    });
    expect(store.get(chatPanelStartPageOpenAtom)).toBe(false);
    expect(store.get(activeSessionIdAtom)).toBe("session-a");
  });

  it("replaces the Launchpad in place, keeping sibling tab order", async () => {
    const {
      chatPanelTabsAtom,
      openOrFocusChatPanelStartPageTabAtom,
      openOrReplaceSessionInChatPanelTabAtom,
      openSessionInNewChatTabAtom,
      store,
    } = await loadChatPanelTabAtoms();

    const launchpadTabId = store.get(chatPanelTabsAtom).activeTabId;
    const trailingTabId = store.set(openSessionInNewChatTabAtom, {
      sessionId: "session-a",
      sessionName: "Session A",
    });
    store.set(openOrFocusChatPanelStartPageTabAtom, {});
    expect(store.get(chatPanelTabsAtom).activeTabId).toBe(launchpadTabId);

    const sessionTabId = store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-b",
      sessionName: "Session B",
    });

    expect(store.get(chatPanelTabsAtom).tabs).toMatchObject([
      { id: sessionTabId, type: "session", sessionId: "session-b" },
      { id: trailingTabId, type: "session", sessionId: "session-a" },
    ]);
  });

  it("does not replace a tab that owns its own surface", async () => {
    const {
      chatPanelTabsAtom,
      openOrReplaceSessionInChatPanelTabAtom,
      openRuntimeInChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();

    const runtimeTabId = store.set(openRuntimeInChatPanelTabAtom, "Runtime");
    const sessionTabId = store.set(openOrReplaceSessionInChatPanelTabAtom, {
      sessionId: "session-a",
      sessionName: "Session A",
    });

    expect(sessionTabId).not.toBe(runtimeTabId);
    expect(store.get(chatPanelTabsAtom).tabs).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: runtimeTabId, type: "runtime" }),
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
    resetInstrumentedStore();
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
    resetInstrumentedStore();
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

describe("GitHub chat-panel detail tabs", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetInstrumentedStore();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens and deduplicates issues and pull requests by repository", async () => {
    const {
      chatPanelTabsAtom,
      openGitHubIssueInChatPanelTabAtom,
      openGitHubPrInChatPanelTabAtom,
      store,
    } = await loadChatPanelTabAtoms();
    const issue = {
      issueNumber: 681,
      issueTitle: "Fix assignment feedback",
      repoPath: "/workspace/ORG2",
      remoteUrl: "https://github.com/org2ai/ORG2.git",
      stateScopeKey: "/workspace/ORG2:681",
    };
    const issueTabId = store.set(openGitHubIssueInChatPanelTabAtom, issue);
    expect(
      store.set(openGitHubIssueInChatPanelTabAtom, {
        ...issue,
        issueTitle: "Updated title",
      })
    ).toBe(issueTabId);

    const prTabId = store.set(openGitHubPrInChatPanelTabAtom, {
      prNumber: 61,
      prTitle: "Agent reliability",
      prUrl: "https://github.com/org2ai/ORG2/pull/61",
      prStatus: "open",
      headBranch: "fix/agents",
      baseBranch: "main",
      repoPath: "/workspace/ORG2",
      repoId: "repo-1",
    });

    expect(store.get(chatPanelTabsAtom)).toEqual(
      expect.objectContaining({
        activeTabId: prTabId,
        tabs: expect.arrayContaining([
          expect.objectContaining({
            id: issueTabId,
            type: "github-issue",
            title: "#681 Updated title",
          }),
          expect.objectContaining({
            id: prTabId,
            type: "github-pr",
          }),
        ]),
      })
    );
  });
});
