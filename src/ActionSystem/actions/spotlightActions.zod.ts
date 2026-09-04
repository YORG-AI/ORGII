/**
 * Spotlight Actions
 *
 * Control the global spotlight search (Cmd+K).
 *
 * Category: "spotlight"
 */
import { z } from "zod";
import type { ZodTypeAny } from "zod";

import { ACTION_ID } from "@src/ActionSystem/actionIds";
import { defineAppActionRegistration } from "@src/ActionSystem/schema/actionRegistration";
import {
  type ZodAction,
  defineZodAction,
} from "@src/ActionSystem/schema/defineZodAction";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";
import {
  openAgentControlSpotlight,
  openAgentSessionSearchSpotlight,
  openAllSessionsSearchSpotlight,
  openBranchSpotlight,
  openCollabOrgSpotlight,
  openEditorSpotlight,
  openSessionCreatorSpotlight,
  openWorkspaceSpotlight,
} from "@src/scaffold/GlobalSpotlight/openSpotlight";
import { spotlightOpenAtom } from "@src/store/ui/uiAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

// ============================================
// Actions
// ============================================

const workspacePickerModeSchema = z.enum(["switch", "open", "add", "create"]);
const collabOrgContextSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("create"),
    source: z.enum(["local", "cloud"]).optional(),
  }),
  z.object({
    mode: z.literal("join"),
    source: z.literal("cloud").optional(),
  }),
]);

const spotlightOpen = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN,
    category: "spotlight",
    description: "Open the global spotlight search",
    params: z.object({}),
    layer: "gui",
    shortcut: getShortcutKeys("spotlight_open"),
    examples: ["open spotlight", "search anything", "quick search"],
  },
  async () => {
    const store = getInstrumentedStore();
    store.set(spotlightOpenAtom, true);
    return { success: true, message: "Spotlight opened" };
  }
);

const spotlightClose = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_CLOSE,
    category: "spotlight",
    description: "Close the global spotlight search",
    params: z.object({}),
    layer: "gui",
  },
  async () => {
    const store = getInstrumentedStore();
    store.set(spotlightOpenAtom, false);
    return { success: true, message: "Spotlight closed" };
  }
);

const spotlightToggle = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_TOGGLE,
    category: "spotlight",
    description: "Toggle the global spotlight search",
    params: z.object({}),
    layer: "gui",
    shortcut: getShortcutKeys("spotlight_open"),
  },
  async () => {
    const store = getInstrumentedStore();
    const current = store.get(spotlightOpenAtom);
    store.set(spotlightOpenAtom, !current);
    return {
      success: true,
      message: current ? "Spotlight closed" : "Spotlight opened",
    };
  }
);

const spotlightOpenWorkspacePicker = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_WORKSPACE_PICKER,
    category: "spotlight",
    description: "Open Spotlight's workspace picker flow",
    params: z.object({
      mode: workspacePickerModeSchema.describe(
        "Workspace picker mode: switch, open, add, or create"
      ),
    }),
    layer: "gui",
    examples: [
      "switch workspace",
      "open folder",
      "add workspace",
      "create Multi-repo Workspace",
    ],
  },
  async ({ mode }) => {
    openWorkspaceSpotlight(mode);
    return { success: true, message: `Opened workspace picker: ${mode}` };
  }
);

const spotlightOpenBranchPicker = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_BRANCH_PICKER,
    category: "spotlight",
    description: "Open Spotlight's branch picker flow",
    params: z.object({}),
    layer: "gui",
    examples: ["switch branch", "open branch picker", "checkout branch"],
  },
  async () => {
    openBranchSpotlight();
    return { success: true, message: "Opened branch picker" };
  }
);

const spotlightOpenEditorFile = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_EDITOR_FILE,
    category: "spotlight",
    description: "Open Spotlight's Code Editor file search flow",
    params: z.object({}),
    layer: "gui",
    shortcut: getShortcutKeys("quick_open"),
    examples: ["open file", "quick open file", "find file"],
  },
  async () => {
    openEditorSpotlight("");
    return { success: true, message: "Opened file search" };
  }
);

const spotlightOpenEditorCommand = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_EDITOR_COMMAND,
    category: "spotlight",
    description: "Open Spotlight's Code Editor command flow",
    params: z.object({}),
    layer: "gui",
    shortcut: getShortcutKeys("spotlight_open"),
    examples: ["open command palette", "run editor command"],
  },
  async () => {
    openEditorSpotlight("", "command");
    return { success: true, message: "Opened editor command palette" };
  }
);

const spotlightOpenEditorSymbol = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_EDITOR_SYMBOL,
    category: "spotlight",
    description: "Open Spotlight's Code Editor symbol search flow",
    params: z.object({}),
    layer: "gui",
    shortcut: getShortcutKeys("go_to_symbol"),
    examples: ["go to symbol", "open symbol search", "find editor symbol"],
  },
  async () => {
    openEditorSpotlight("", "symbol");
    return { success: true, message: "Opened editor symbol search" };
  }
);

const spotlightOpenAgentSessionSearch = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_AGENT_SESSION_SEARCH,
    category: "spotlight",
    description: "Open Spotlight's Agent session search flow",
    params: z.object({}),
    layer: "gui",
    shortcut: getShortcutKeys("agent_session_search"),
    examples: ["search agent sessions", "open session", "find session"],
  },
  async () => {
    openAgentSessionSearchSpotlight();
    return { success: true, message: "Opened Agent session search" };
  }
);

const spotlightOpenAllSessionsSearch = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_ALL_SESSIONS_SEARCH,
    category: "spotlight",
    description: "Open Spotlight's full-text search across all sessions",
    params: z.object({}),
    layer: "gui",
    examples: [
      "search across all sessions",
      "search session content",
      "search transcripts",
    ],
  },
  async () => {
    openAllSessionsSearchSpotlight();
    return { success: true, message: "Opened all-sessions search" };
  }
);

const spotlightOpenAgentControl = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_AGENT_CONTROL,
    category: "spotlight",
    description: "Open Spotlight's Agent Control flow",
    params: z.object({}),
    layer: "gui",
    shortcut: getShortcutKeys("toggle_ade_manager"),
    examples: ["ade manager", "open ADE Manager", "manage agents"],
  },
  async () => {
    openAgentControlSpotlight();
    return { success: true, message: "Opened Agent Control" };
  }
);

const spotlightOpenSessionCreator = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_SESSION_CREATOR,
    category: "spotlight",
    description: "Open Spotlight's inline session creator",
    params: z.object({}),
    layer: "gui",
    shortcut: getShortcutKeys("new_session"),
    examples: ["new session", "create session", "open session creator"],
  },
  async () => {
    openSessionCreatorSpotlight();
    return { success: true, message: "Opened session creator" };
  }
);

const spotlightOpenCollabOrg = defineZodAction(
  {
    id: ACTION_ID.SPOTLIGHT_OPEN_COLLAB_ORG,
    category: "spotlight",
    description: "Open Spotlight's organization create or join flow",
    params: collabOrgContextSchema,
    layer: "gui",
    examples: [
      "create an organization",
      "create an ORG",
      "join an organization",
      "join an ORG",
    ],
  },
  async ({ mode, source }) => {
    openCollabOrgSpotlight({
      mode,
      source: mode === "join" ? "cloud" : source,
    });
    return {
      success: true,
      message: `Opened organization ${mode} flow`,
    };
  }
);

// ============================================
// Export
// ============================================

export const spotlightZodActions: ZodAction<ZodTypeAny>[] = [
  spotlightOpen,
  spotlightClose,
  spotlightToggle,
  spotlightOpenWorkspacePicker,
  spotlightOpenBranchPicker,
  spotlightOpenEditorFile,
  spotlightOpenEditorCommand,
  spotlightOpenEditorSymbol,
  spotlightOpenAgentSessionSearch,
  spotlightOpenAllSessionsSearch,
  spotlightOpenAgentControl,
  spotlightOpenSessionCreator,
  spotlightOpenCollabOrg,
];

export const spotlightActionRegistration =
  defineAppActionRegistration(spotlightZodActions);
