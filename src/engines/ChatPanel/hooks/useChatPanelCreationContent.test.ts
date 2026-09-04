// @vitest-environment jsdom
import { Provider } from "jotai";
import { type ComponentProps, act, createElement } from "react";
import { type Root, createRoot } from "react-dom/client";
import { useTranslation } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHAT_PANEL_CREATE_TARGET } from "@src/store/ui/chatPanelAtom";
import type { WorkItemDraft } from "@src/store/workstation/projectManager";

import type { ChatPanelEmptyContent } from "../ChatPanelEmptyContent";
import type { useAiWorkItemCreator } from "./useAiWorkItemCreator";
import { useChatPanelCreationContent } from "./useChatPanelCreationContent";

type ContentProps = ComponentProps<typeof ChatPanelEmptyContent>;
const mocks = vi.hoisted(() => ({
  content: null as ContentProps | null,
  aiOptions: null as Parameters<typeof useAiWorkItemCreator>[0] | null,
  navigate: vi.fn(),
  resetActiveSession: vi.fn(),
  launchpad: vi.fn(),
  openSession: vi.fn(),
  installUpdate: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("react-router-dom", () => ({ useNavigate: () => mocks.navigate }));
vi.mock("@src/api/http/project", () => ({ workItemDataToUI: vi.fn() }));
vi.mock("@src/scaffold/AppUpdater", () => ({
  installAvailableAppUpdate: mocks.installUpdate,
}));
vi.mock("@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom", async () => {
  const { atom } = await import("jotai");
  return { allAgentDefsAtom: atom([]) };
});
vi.mock("@src/store/session", async () => {
  const { atom } = await import("jotai");
  return { sessionCreatorStateAtom: atom({}) };
});
vi.mock("@src/store/project/projectAtom", async () => {
  const { atom } = await import("jotai");
  return { projectListRefreshAtom: atom(0) };
});
vi.mock("@src/store/ui/chatPanelAtom", async () => {
  const { atom } = await import("jotai");
  return {
    CHAT_PANEL_CREATE_TARGET: {
      AGENT_SESSION: "agent-session",
      PROJECT: "project",
      WORK_ITEM: "work-item",
      PARALLEL_RUN: "parallel-run",
    },
    chatPanelStartPageOpenAtom: atom(false),
    chatPanelCreateTargetAtom: atom("work-item"),
    chatPanelCreateProjectContextAtom: atom(null),
    chatPanelSelectedProjectAtom: atom(null),
    chatPanelSelectedWorkItemAtom: atom(null),
  };
});
vi.mock("@src/store/chatPanel/chatPanelTabsAtom", async () => {
  const { atom } = await import("jotai");
  return {
    openProjectInChatPanelTabAtom: atom(null, vi.fn()),
    openWorkItemInChatPanelTabAtom: atom(null, vi.fn()),
    openOrReplaceSessionInChatPanelTabAtom: atom(null, (_get, _set, value) =>
      mocks.openSession(value)
    ),
  };
});
vi.mock("./useChatPanelNavigationActions", () => ({
  useChatPanelNavigationActions: () => ({
    dispatchClearSession: vi.fn(),
    resetActiveSession: mocks.resetActiveSession,
    setActiveSessionId: vi.fn(),
    setWorkstationActiveSessionId: vi.fn(),
  }),
}));
vi.mock("./useAiWorkItemCreator", () => ({
  useAiWorkItemCreator: (
    options: Parameters<typeof useAiWorkItemCreator>[0]
  ) => {
    mocks.aiOptions = options;
    return {
      defaultAiWorkItemExecutionTarget: null,
      handleAiWorkItemSessionStart: vi.fn(),
      resolveAiWorkItemContext: vi.fn(),
    };
  },
}));
vi.mock("../ChatPanelEmptyContent", () => ({
  ChatPanelEmptyContent: (props: ContentProps) => {
    mocks.content = props;
    return createElement("div", { "data-testid": "creator" });
  },
}));

const slot = () => null;
function Harness({ visible }: { visible: boolean }) {
  const { t } = useTranslation([
    "sessions",
    "common",
    "projects",
    "navigation",
  ]);
  const content = useChatPanelCreationContent({
    t,
    startPageOpen: false,
    sessionCreatorSlot: slot,
    creatorVariant: "fullScreen",
    handleShowRuntime: vi.fn(),
    handleOpenLaunchpadTab: mocks.launchpad,
    handleOpenCliTerminal: vi.fn(),
    handleRegionNoticeChange: vi.fn(),
  });
  return visible ? content : null;
}

describe("chat creation ownership", () => {
  let root: Root;
  let container: HTMLDivElement;
  const actEnvironment = globalThis as typeof globalThis & {
    IS_REACT_ACT_ENVIRONMENT?: boolean;
  };
  function render(visible: boolean) {
    act(() =>
      root.render(
        createElement(Provider, null, createElement(Harness, { visible }))
      )
    );
  }
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    vi.clearAllMocks();
    container = document.createElement("div");
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    Reflect.deleteProperty(actEnvironment, "IS_REACT_ACT_ENVIRONMENT");
  });

  it("retains drafts and manual creator choices while another tab hides the surface", () => {
    render(true);
    const draft: WorkItemDraft = {
      name: "unfinished work",
      description: "",
      status: "todo",
      priority: "medium",
      labelIds: [],
    };
    act(() => {
      mocks.content!.setWorkItemCreateDraft(draft);
      mocks.content!.handleWorkItemAgentCreatorToggle(false);
      mocks.content!.handleProjectAgentCreatorToggle(false);
    });
    render(false);
    expect(container.childNodes).toHaveLength(0);
    expect(mocks.aiOptions!.workItemCreateDraft).toBe(draft);
    render(true);
    expect(mocks.aiOptions!.workItemCreateDraft).toBe(draft);
    expect(mocks.content!.showWorkItemAgentCreator).toBe(false);
    expect(mocks.content!.showProjectAgentCreator).toBe(false);
    expect(mocks.content!.creatorVariant).toBe("fullScreen");
    expect(mocks.launchpad).not.toHaveBeenCalled();
  });

  it("keeps Spotlight-owned actions out of the create-target dropdown", () => {
    render(true);
    expect(mocks.content!.createTargetOptions).toEqual([
      expect.objectContaining({
        value: CHAT_PANEL_CREATE_TARGET.PROJECT,
      }),
      expect.objectContaining({
        value: CHAT_PANEL_CREATE_TARGET.PARALLEL_RUN,
      }),
    ]);
  });

  it("routes a Launchpad-created session through placeholder replacement", () => {
    render(true);

    act(() => {
      mocks.content!.handleStartPageSessionStart({ sessionId: "session-a" });
    });

    expect(mocks.openSession).toHaveBeenCalledWith({ sessionId: "session-a" });
  });
});
