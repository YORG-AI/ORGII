import { ACTION_ID } from "@src/ActionSystem";
import { LANGUAGE_NAMES, SUPPORTED_LANGUAGES } from "@src/i18n";
import {
  ArrowLeft02Icon,
  ArrowRight02Icon,
  ArrowUp02Icon,
  Cancel01Icon,
  CenterFocusIcon,
  Clock01Icon,
  CloudIcon,
  CodeXmlIcon,
  Delete02Icon,
  Download02Icon,
  FolderAddIcon,
  FolderClosedIcon,
  FolderImportIcon,
  FolderLibraryIcon,
  FolderOpenIcon,
  FolderSearchIcon,
  FolderSymlinkIcon,
  GithubIcon,
  HelpCircleIcon,
  Home01Icon,
  InternetIcon,
  LanguageCircleIcon,
  LaptopMinimalIcon,
  Layers01Icon,
  Layout01Icon,
  LockIcon,
  Message01Icon,
  Pen01Icon,
  Refresh04Icon,
  RocketIcon,
  Search01Icon,
  Settings01Icon,
  SparklesIcon,
  SquareArrowUpRight02Icon,
  Tick01Icon,
  WorkHistoryIcon,
  WorkflowCircle05Icon,
} from "@src/icons";

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
  addWorkspace: FolderImportIcon,

  // Shared UI
  repo: CodeXmlIcon,
  config: Settings01Icon,
  done: Tick01Icon,
  language: LanguageCircleIcon,

  // Workspace modes
  focusMode: CenterFocusIcon,
  stackMode: Layers01Icon,

  // Repo actions
  showFinder: FolderSearchIcon,

  // Add repo
  newRepo: FolderAddIcon,
  cloneRepo: Download02Icon,
  cloneRepoUrl: Download02Icon,
  importRepo: FolderSymlinkIcon,

  // Navigation / Pages
  home: Home01Icon,
  workspace: FolderLibraryIcon,
  workspaceLayout: Layout01Icon,
  folder: FolderClosedIcon,
  folderOpen: FolderOpenIcon,
  folderPlus: FolderAddIcon,

  // Tab types
  tabOpen: SquareArrowUpRight02Icon,
  tabClosed: WorkHistoryIcon,
  tabChat: Message01Icon,
  tabAgent: SparklesIcon,

  // Misc
  refresh: Refresh04Icon,
  search: Search01Icon,
  branch: WorkflowCircle05Icon,
  worktree: FolderClosedIcon,
  close: Cancel01Icon,
  arrowRight: ArrowRight02Icon,
  arrowUp: ArrowUp02Icon,
  rocket: RocketIcon,
  back: ArrowLeft02Icon,
  emptyState: HelpCircleIcon,

  // AI/LLM
  aiSpark: SparklesIcon,

  // Selector-specific icons
  switchRepo: CodeXmlIcon,
  removeRepo: Delete02Icon,
  removeBranch: Delete02Icon,
  editRepo: Pen01Icon,
  recent: Clock01Icon,
  local: CodeXmlIcon,
  github: GithubIcon,
  githubPublic: InternetIcon,
  githubPrivate: LockIcon,
  cloudSandbox: CloudIcon,
  localDevice: LaptopMinimalIcon,
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
export { SPOTLIGHT_CONFIG } from "./constants";
