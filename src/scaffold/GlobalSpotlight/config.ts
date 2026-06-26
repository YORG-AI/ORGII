import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Check,
  CircleHelp,
  Clock,
  Cloud,
  Code,
  Focus,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderSearch,
  FolderSymlink,
  FolderTree,
  GitBranch,
  GitFork,
  Github,
  Globe,
  History,
  Home,
  Languages,
  LaptopMinimal,
  Layers,
  Layout,
  Link2,
  Lock,
  MessageSquare,
  Pencil,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  Sparkles,
  SquareArrowOutUpRight,
  SquareArrowRight,
  Trash2,
  X,
} from "lucide-react";

import { ACTION_ID } from "@src/ActionSystem";
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from "@src/i18n";

import type { ActionDefinition } from "./types";

export { NAV_DESTINATIONS } from "./navDestinations";
export { searchNavDestinations } from "./navDestinationsSearch";
export type {
  NavDestination,
  NavDestinationGroup,
} from "./navDestinationsTypes";

// ============ ICON CONFIG ============

export const ICONS = {
  // Actions
  addWorkspace: SquareArrowRight,

  // Shared UI
  repo: Code,
  config: Settings,
  done: Check,
  language: Languages,

  // Workspace modes
  focusMode: Focus,
  stackMode: Layers,

  // Repo actions
  showFinder: FolderSearch,

  // Add repo
  newRepo: FolderPlus,
  cloneRepo: Lock,
  cloneRepoUrl: Link2,
  importRepo: FolderSymlink,

  // Navigation / Pages
  home: Home,
  workspace: FolderTree,
  workspaceLayout: Layout,
  folder: Folder,
  folderOpen: FolderOpen,
  folderPlus: FolderPlus,

  // Tab types
  tabOpen: SquareArrowOutUpRight,
  tabClosed: History,
  tabChat: MessageSquare,
  tabAgent: Sparkles,

  // Misc
  refresh: RefreshCw,
  search: Search,
  branch: GitBranch,
  worktree: GitFork,
  close: X,
  arrowRight: ArrowRight,
  arrowUp: ArrowUp,
  rocket: Rocket,
  back: ArrowLeft,
  emptyState: CircleHelp,

  // AI/LLM
  aiSpark: Sparkles,

  // Selector-specific icons
  switchRepo: FolderTree,
  removeRepo: Trash2,
  removeBranch: Trash2,
  editRepo: Pencil,
  recent: Clock,
  local: Code,
  github: Github,
  githubPublic: Globe,
  githubPrivate: Lock,
  cloudSandbox: Cloud,
  localDevice: LaptopMinimal,
} as const;

// ============ ACTIONS WITH REQUIRED PARAMS ============
// This is the core config - each action defines what parameters it needs

export const ACTIONS: ActionDefinition[] = [
  {
    id: ACTION_ID.SETTINGS_SET_LANGUAGE,
    label: "Change language",
    labelKey: "common:spotlightActions.changeLanguage",
    pillLabelKey: "common:spotlightActions.changeLanguage",
    icon: ICONS.language,
    color: "primary",
    requiredParams: ["language"],
    keywords: ["language", "locale", "translation", "i18n"],
    aliases: [
      "change language",
      "set language",
      "switch language",
      "app language",
      ...SUPPORTED_LANGUAGES,
      ...Object.values(LANGUAGE_NAMES),
    ],
  },

  // File actions - require repo
  {
    id: "show-in-finder",
    label: "Locate repo in Finder",
    labelKey: "selectors.spotlight.actions.showInFinder.label",
    pillLabelKey: "selectors.spotlight.actions.showInFinder.pillLabel",
    icon: ICONS.showFinder,
    color: "primary",
    requiredParams: ["repo"],
    keywords: ["finder", "folder", "reveal"],
    aliases: [
      "finder",
      "reveal",
      "show in finder",
      "explore",
      "open finder",
      "open folder",
      "show folder",
      "reveal in finder",
      "locate folder",
      "find folder",
      "open in finder",
      "browse files",
    ],
  },

  // Note: The legacy add-workspace action + sub-actions were removed. The
  // add workspace flow (Create / Clone URL / Clone GitHub / Import) now lives
  // entirely inside `WorkspacePalette` via `useAddWorkspaceFlow`, so GlobalSpotlight
  // doesn't need a top-level action entry for it.
];

// ============ HELPER: Get action by ID ============

export const getActionById = (id: string): ActionDefinition | undefined =>
  ACTIONS.find((actionItem) => actionItem.id === id);

// ============ TAG COLORS BY TYPE ============

export const TAG_COLORS: Record<string, string> = {
  action: "primary", // blue (primary-6)
  repo: "warning", // orange (warning-6)
  branch: "warning", // orange (warning-6)
  language: "success",
};

// ============ SPOTLIGHT POSITIONING CONFIG ============
// Re-export from constants.ts to avoid circular dependency
export { LIMITS, SPOTLIGHT_CONFIG } from "./constants";
