// @vitest-environment jsdom
import { Provider, createStore } from "jotai";
import { act, createElement, useEffect } from "react";
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

import type { CreatedProjectResult } from "@src/modules/ProjectManager/Projects/components/CreateProjectView";
import type { CreatedWorkItemResult } from "@src/modules/ProjectManager/WorkItems/components/CreateWorkItemView";
import {
  activeChatPanelTabAtom,
  chatPanelTabsAtom,
} from "@src/store/chatPanel/chatPanelTabsAtom";
import { CHAT_PANEL_CREATE_TARGET } from "@src/store/ui/chatPanelAtom";

import { useProjectWorkItemHandlers } from "./useProjectWorkItemHandlers";

type ProjectWorkItemHandlers = ReturnType<typeof useProjectWorkItemHandlers>;

const callbacks = {
  bumpProjectListRefresh: vi.fn(),
  dispatchClearSession: vi.fn(),
  handleReturnToSessionCreator: vi.fn(),
  setActiveSessionId: vi.fn(),
  setCreateTarget: vi.fn(),
  setSelectedProject: vi.fn(),
  setSelectedWorkItem: vi.fn(),
  setShowProjectAgentCreator: vi.fn(),
  setShowWorkItemAgentCreator: vi.fn(),
  setWorkItemCreateDraft: vi.fn(),
  setWorkstationActiveSessionId: vi.fn(),
};

let handlers: ProjectWorkItemHandlers | null = null;

function Harness({
  onReady,
}: {
  onReady: (value: ProjectWorkItemHandlers) => void;
}) {
  const value = useProjectWorkItemHandlers({
    ...callbacks,
    createProjectContext: null,
    sessionCreatorAvailable: true,
  });
  useEffect(() => onReady(value), [onReady, value]);
  return null;
}

describe("useProjectWorkItemHandlers", () => {
  let container: HTMLDivElement;
  let root: Root;
  let store: ReturnType<typeof createStore>;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };

  beforeAll(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
  });

  beforeEach(() => {
    handlers = null;
    store = createStore();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(
        createElement(
          Provider,
          { store },
          createElement(Harness, {
            onReady: (value) => {
              handlers = value;
            },
          })
        )
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
  });

  afterAll(() => {
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("opens a manually created project in its active project tab", () => {
    const result: CreatedProjectResult = {
      project: {
        id: "proj-launchpad-project",
        name: "Launchpad Project",
        slug: "launchpad-project",
        status: "backlog",
        priority: "none",
        health: "no_updates",
        createdAt: "2026-08-10T00:00:00.000Z",
        updatedAt: "2026-08-10T00:00:00.000Z",
      },
      projectSlug: "launchpad-project",
      orgId: "personal-org",
      orgName: "My Personal Org",
    };

    act(() => handlers?.handleChatPanelProjectCreated(result));

    expect(store.get(activeChatPanelTabAtom)).toMatchObject({
      type: "project",
      title: "Launchpad Project",
      project: result,
    });
    expect(
      store.get(chatPanelTabsAtom).tabs.filter((tab) => tab.type === "project")
    ).toHaveLength(1);
    expect(callbacks.setCreateTarget).toHaveBeenCalledWith(
      CHAT_PANEL_CREATE_TARGET.AGENT_SESSION
    );
    expect(callbacks.dispatchClearSession).toHaveBeenCalledOnce();
    expect(callbacks.setActiveSessionId).toHaveBeenCalledWith(null);
    expect(callbacks.setWorkstationActiveSessionId).toHaveBeenCalledWith(null);
    expect(callbacks.handleReturnToSessionCreator).not.toHaveBeenCalled();
  });

  it("opens a manually created work item in its active work-item tab", () => {
    const result: CreatedWorkItemResult = {
      shortId: "LCH-0001",
      projectSlug: "launchpad-project",
      workItem: {
        session_id: "work-item-row-id",
        shortId: "LCH-0001",
        user_id: "",
        name: "Launch from Launchpad",
        status: "planned",
        spec: "",
        star: false,
        target_date: null,
        created_time: "2026-08-10T00:00:00.000Z",
        updated_time: "2026-08-10T00:00:00.000Z",
        project: {
          id: "proj-launchpad-project",
          name: "Launchpad Project",
        },
      },
    };

    act(() => handlers?.handleChatPanelWorkItemCreated(result));

    expect(store.get(activeChatPanelTabAtom)).toMatchObject({
      type: "work-item",
      title: "Launch from Launchpad",
      workItem: {
        shortId: "LCH-0001",
        projectSlug: "launchpad-project",
        workItem: result.workItem,
      },
    });
    expect(
      store
        .get(chatPanelTabsAtom)
        .tabs.filter((tab) => tab.type === "work-item")
    ).toHaveLength(1);
    expect(callbacks.dispatchClearSession).toHaveBeenCalledOnce();
    expect(callbacks.handleReturnToSessionCreator).not.toHaveBeenCalled();
  });
});
