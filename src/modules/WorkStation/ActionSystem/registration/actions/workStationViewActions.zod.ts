import { z } from "zod";

import { ACTION_ID, type ActionId } from "@src/ActionSystem/actionIds";
import { defineZodAction } from "@src/ActionSystem/schema/defineZodAction";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";

const NAVIGATION_SHORTCUT_OPTIONS = {
  toggleChatPanelMaximizedWhenActive: true,
} as const;

async function getWorkStationViewService() {
  const { WorkStationViewService } = await import("@src/services/workStation");
  return WorkStationViewService;
}

export const workstationToggleChatFocus = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_TOGGLE_CHAT_FOCUS,
    category: "view",
    description: "Focus the Workstation chat panel or restore Workstation",
    params: z.object({}),
    shortcut: getShortcutKeys("maximize_chat"),
    tags: ["workstation", "chat", "view"],
    examples: [
      "focus chat panel",
      "hide work station",
      "show work station",
      "restore work station",
    ],
  },
  async () => {
    const workStationViewService = await getWorkStationViewService();
    const success = await workStationViewService.toggleChatPanelMaximized();
    return success
      ? { success: true, message: "Toggled Workstation chat focus" }
      : { success: false, message: "Workstation chat focus is not available" };
  }
);

export const workstationToggleChatPanelVisibility = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_TOGGLE_CHAT_PANEL_VISIBILITY,
    category: "view",
    description: "Maximize Workstation or restore the Chat Panel",
    params: z.object({}),
    shortcut: getShortcutKeys("maximize_work_station"),
    tags: ["workstation", "chat", "view"],
    examples: [
      "maximize work station",
      "hide chat panel",
      "restore chat panel",
      "show chat panel",
    ],
  },
  async () => {
    const workStationViewService = await getWorkStationViewService();
    const success = await workStationViewService.showWorkStation();
    return success
      ? { success: true, message: "Toggled Workstation chat panel" }
      : { success: false, message: "Workstation chat panel is not available" };
  }
);

function defineOpenStationAction(
  id: ActionId,
  mode: "my-station" | "agent-station",
  description: string,
  message: string,
  shortcut: string,
  examples: string[]
) {
  return defineZodAction(
    {
      id,
      category: "navigation",
      description,
      params: z.object({}),
      ...(shortcut ? { shortcut } : {}),
      tags: ["workstation", "station", mode, "navigation"],
      examples,
    },
    async () => {
      const workStationViewService = await getWorkStationViewService();
      const success = await workStationViewService.openStationMode(mode);
      return success
        ? { success: true, message }
        : {
            success: false,
            message: "Workstation station mode is not available",
          };
    }
  );
}

export const workstationOpenMyStation = defineOpenStationAction(
  ACTION_ID.WORKSTATION_OPEN_MY_STATION,
  "my-station",
  "Switch Workstation to My Station",
  "Opened My Station",
  "",
  ["open my station", "switch to my station", "show my station"]
);

export const workstationOpenAgentStation = defineOpenStationAction(
  ACTION_ID.WORKSTATION_OPEN_AGENT_STATION,
  "agent-station",
  "Switch Workstation to Agent Station",
  "Opened Agent Station",
  "",
  ["open agent station", "switch to agent station", "show agent station"]
);

export const workstationOpenKanban = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_OPEN_KANBAN,
    category: "navigation",
    description: "Open Kanban in the chat pane",
    params: z.object({}),
    shortcut: getShortcutKeys("open_kanban"),
    tags: ["workstation", "chat", "kanban", "navigation"],
    examples: ["open kanban", "go to kanban", "show kanban"],
  },
  async () => {
    const workStationViewService = await getWorkStationViewService();
    const success = await workStationViewService.openKanbanTab();
    return success
      ? { success: true, message: "Opened Kanban" }
      : { success: false, message: "Kanban is not available" };
  }
);

export const workstationToggleSidebar = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_TOGGLE_SIDEBAR,
    category: "view",
    description:
      "Toggle the Workstation sidebar between collapsed and expanded",
    params: z.object({}),
    shortcut: getShortcutKeys("toggle_workstation_sidebar"),
    tags: ["workstation", "work-station-sidebar", "tool-sidebar", "view"],
    examples: [
      "toggle work station sidebar",
      "hide work station sidebar",
      "show work station sidebar",
      "toggle tool sidebar",
    ],
  },
  async () => {
    const workStationViewService = await getWorkStationViewService();
    const success = await workStationViewService.toggleWorkstationSidebar();
    return success
      ? { success: true, message: "Toggled Workstation sidebar" }
      : { success: false, message: "Workstation sidebar is not available" };
  }
);

export const workstationOpenCodeEditorTab = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_OPEN_CODE_EDITOR_TAB,
    category: "navigation",
    description: "Open the Code Editor and focus a specific pinned tab",
    params: z.object({
      tabId: z.string().min(1).describe("Code Editor tab ID to focus"),
    }),
    tags: ["workstation", "code-editor", "tab"],
    examples: ["open code editor tab", "focus code editor tab"],
  },
  async ({ tabId }) => {
    const workStationViewService = await getWorkStationViewService();
    const success = await workStationViewService.openCodeEditorTab(tabId);
    return success
      ? { success: true, message: "Opened Code Editor tab" }
      : { success: false, message: "Code Editor tab is not available" };
  }
);

export const workstationOpenFileFolderTab = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_OPEN_FILE_FOLDER_TAB,
    category: "navigation",
    description:
      "Open the last visited regular file tab or the default File Folder tab",
    params: z.object({}),
    shortcut: getShortcutKeys("open_file_folder_tab"),
    tags: ["workstation", "code-editor", "file", "folder"],
    examples: ["open file folder", "go to last file", "show explorer"],
  },
  async () => {
    const workStationViewService = await getWorkStationViewService();
    const success = await workStationViewService.openFileFolderTab(
      NAVIGATION_SHORTCUT_OPTIONS
    );
    return success
      ? { success: true, message: "Opened File Folder tab" }
      : { success: false, message: "File Folder tab is not available" };
  }
);

export const workstationOpenSourceControlTab = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_OPEN_SOURCE_CONTROL_TAB,
    category: "navigation",
    description: "Open the Code Editor Source Control tab",
    params: z.object({}),
    shortcut: getShortcutKeys("open_source_control_tab"),
    tags: ["workstation", "code-editor", "source-control", "git"],
    examples: ["open source control", "show git changes"],
  },
  async () => {
    const workStationViewService = await getWorkStationViewService();
    const success = await workStationViewService.openSourceControlTab(
      NAVIGATION_SHORTCUT_OPTIONS
    );
    return success
      ? { success: true, message: "Opened Source Control tab" }
      : { success: false, message: "Source Control tab is not available" };
  }
);

export const workstationOpenSearchSidebar = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_OPEN_SEARCH_SIDEBAR,
    category: "navigation",
    description:
      "Open the Code Editor Search sidebar and focus the search input",
    params: z.object({
      query: z
        .string()
        .optional()
        .describe("Optional search query to populate"),
    }),
    shortcut: getShortcutKeys("search_files"),
    tags: ["workstation", "code-editor", "search", "sidebar"],
    examples: ["open search sidebar", "search in files", "focus search"],
  },
  async ({ query }) => {
    const workStationViewService = await getWorkStationViewService();
    const success = await workStationViewService.openSearchSidebar(
      query,
      NAVIGATION_SHORTCUT_OPTIONS
    );
    return success
      ? { success: true, message: "Opened Search sidebar" }
      : { success: false, message: "Search sidebar is not available" };
  }
);

export const workstationCreateProject = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_CREATE_PROJECT,
    category: "navigation",
    description: "Navigate to My Station and open the Create Project form",
    params: z.object({}),
    tags: ["workstation", "project", "create", "navigation"],
    examples: ["create project", "new project", "add project"],
  },
  async () => {
    const workStationViewService = await getWorkStationViewService();
    await workStationViewService.openStationMode("my-station");
    const { chatPanelNavigateAtom, CHAT_PANEL_SURFACE_KIND } =
      await import("@src/store/ui/chatPanelAtom");
    const { getInstrumentedStore } =
      await import("@src/util/core/state/instrumentedStore");
    getInstrumentedStore().set(chatPanelNavigateAtom, {
      kind: CHAT_PANEL_SURFACE_KIND.NEW_PROJECT,
    });
    return { success: true, message: "Opened Create Project" };
  }
);

export const workstationCreateWorkItem = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_CREATE_WORK_ITEM,
    category: "navigation",
    description: "Navigate to My Station and open the Create Work Item form",
    params: z.object({}),
    tags: ["workstation", "work-item", "create", "navigation"],
    examples: [
      "create work item",
      "new work item",
      "add work item",
      "new task",
    ],
  },
  async () => {
    const workStationViewService = await getWorkStationViewService();
    await workStationViewService.openStationMode("my-station");
    const { chatPanelNavigateAtom, CHAT_PANEL_SURFACE_KIND } =
      await import("@src/store/ui/chatPanelAtom");
    const { getInstrumentedStore } =
      await import("@src/util/core/state/instrumentedStore");
    getInstrumentedStore().set(chatPanelNavigateAtom, {
      kind: CHAT_PANEL_SURFACE_KIND.NEW_WORK_ITEM,
    });
    return { success: true, message: "Opened Create Work Item" };
  }
);

export const workstationOpenTerminalTab = defineZodAction(
  {
    id: ACTION_ID.WORKSTATION_OPEN_TERMINAL_TAB,
    category: "navigation",
    description: "Open the WorkStation terminal view",
    params: z.object({}),
    shortcut: getShortcutKeys("open_terminal_tab"),
    tags: ["workstation", "code-editor", "terminal"],
    examples: ["open terminal tab", "show terminal"],
  },
  async () => {
    const workStationViewService = await getWorkStationViewService();
    const success = await workStationViewService.openTerminalTab(
      NAVIGATION_SHORTCUT_OPTIONS
    );
    return success
      ? { success: true, message: "Opened Terminal tab" }
      : { success: false, message: "Terminal tab is not available" };
  }
);

export const workStationViewZodActions = [
  workstationToggleChatFocus,
  workstationToggleChatPanelVisibility,
  workstationOpenMyStation,
  workstationOpenAgentStation,
  workstationOpenKanban,
  workstationToggleSidebar,
  workstationOpenCodeEditorTab,
  workstationOpenFileFolderTab,
  workstationOpenSourceControlTab,
  workstationOpenSearchSidebar,
  workstationOpenTerminalTab,
  workstationCreateProject,
  workstationCreateWorkItem,
];
