import { describe, expect, it } from "vitest";

import {
  CHAT_PANEL_CONTENT_MODE,
  CHAT_PANEL_CREATE_TARGET,
  CHAT_PANEL_SURFACE_KIND,
  type ChatPanelSelectedWorkItem,
  type ChatPanelSelectedWorkspace,
  WORKSPACE_OVERVIEW_TAB,
} from "@src/store/ui/chatPanelAtom";

import { reduceChatPanelSurfaceCommand } from "./chatPanelSurfaceReducer";

const sampleWorkItem = {
  workItem: { id: "work-item-1", title: "Fix navigation" },
  projectId: "project-1",
  projectName: "Project",
  projectSlug: "project",
  shortId: "ORG-1",
} as unknown as ChatPanelSelectedWorkItem;

const sampleWorkspace = {
  kind: "repo",
  id: "repo-1",
  name: "Repo",
  path: "/tmp/repo",
} satisfies ChatPanelSelectedWorkspace;

describe("reduceChatPanelSurfaceCommand", () => {
  it("clears Explore state when navigating to New Work Item", () => {
    const snapshot = reduceChatPanelSurfaceCommand({
      kind: CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM,
    });

    expect(snapshot.contentMode).toBe(CHAT_PANEL_CONTENT_MODE.NON_SESSION);
    expect(snapshot.createTarget).toBe(CHAT_PANEL_CREATE_TARGET.WORK_ITEM);
    expect(snapshot.exploreOpen).toBe(false);
    expect(snapshot.selectedWorkspace).toBeNull();
    expect(snapshot.selectedProject).toBeNull();
    expect(snapshot.selectedWorkItem).toBeNull();
  });

  it("clears Explore state when navigating to New Project", () => {
    const snapshot = reduceChatPanelSurfaceCommand({
      kind: CHAT_PANEL_SURFACE_KIND.NEW_PROJECT,
    });

    expect(snapshot.contentMode).toBe(CHAT_PANEL_CONTENT_MODE.NON_SESSION);
    expect(snapshot.createTarget).toBe(CHAT_PANEL_CREATE_TARGET.PROJECT);
    expect(snapshot.exploreOpen).toBe(false);
  });

  it("opening a session clears non-session surfaces", () => {
    const snapshot = reduceChatPanelSurfaceCommand({
      kind: CHAT_PANEL_SURFACE_KIND.SESSION,
    });

    expect(snapshot.contentMode).toBe(CHAT_PANEL_CONTENT_MODE.SESSION);
    expect(snapshot.createTarget).toBe(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
    expect(snapshot.exploreOpen).toBe(false);
    expect(snapshot.selectedWorkItem).toBeNull();
  });

  it("sets work item as the only selected detail surface", () => {
    const snapshot = reduceChatPanelSurfaceCommand({
      kind: CHAT_PANEL_SURFACE_KIND.WORK_ITEM,
      workItem: sampleWorkItem,
    });

    expect(snapshot.selectedWorkItem).toBe(sampleWorkItem);
    expect(snapshot.selectedProject).toBeNull();
    expect(snapshot.selectedWorkspace).toBeNull();
    expect(snapshot.exploreOpen).toBe(false);
  });

  it("opens workspace overview details without Explore", () => {
    const snapshot = reduceChatPanelSurfaceCommand({
      kind: CHAT_PANEL_SURFACE_KIND.WORKSPACE_OVERVIEW,
      workspace: sampleWorkspace,
      tab: WORKSPACE_OVERVIEW_TAB.DETAILS,
    });

    expect(snapshot.selectedWorkspace).toBe(sampleWorkspace);
    expect(snapshot.workspaceOverviewTab).toBe(WORKSPACE_OVERVIEW_TAB.DETAILS);
    expect(snapshot.exploreOpen).toBe(false);
  });

  it("keeps the org create context when an org panel opens New Work Item", () => {
    // Org-panel flow: an org surface navigates to NEW_WORK_ITEM carrying the
    // aliased project org. Tearing down the org surface must not drop the
    // context — it is what scopes the standalone write to the org.
    const cloudOrgSnapshot = reduceChatPanelSurfaceCommand({
      kind: CHAT_PANEL_SURFACE_KIND.CLOUD_ORG,
      cloudOrg: { orgId: "cloud-org-1" },
    });

    const createContext = {
      orgId: "project-org-1",
      scopeBreadcrumbLabel: "Acme Team",
    };
    const snapshot = reduceChatPanelSurfaceCommand(
      {
        kind: CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM,
        createProjectContext: createContext,
      },
      cloudOrgSnapshot
    );

    expect(snapshot.createTarget).toBe(CHAT_PANEL_CREATE_TARGET.WORK_ITEM);
    expect(snapshot.createProjectContext).toEqual(createContext);
    expect(snapshot.selectedCloudOrg).toBeNull();
  });

  it("drops a stale create context when New Work Item navigates without one", () => {
    const scopedSnapshot = reduceChatPanelSurfaceCommand({
      kind: CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM,
      createProjectContext: { orgId: "project-org-1" },
    });

    const snapshot = reduceChatPanelSurfaceCommand(
      { kind: CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM },
      scopedSnapshot
    );

    expect(snapshot.createProjectContext).toBeNull();
  });
});
