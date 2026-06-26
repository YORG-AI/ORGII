/**
 * Palette Configurations
 *
 * Centralized configurations for all palette components.
 * This is the SINGLE SOURCE OF TRUTH for:
 * - Path/template definitions
 * - Placeholder text
 * - Labels and icons
 * - Palette mode configurations
 */
import {
  Command,
  File,
  FolderPlus,
  FolderTree,
  GitBranch,
  GitBranchMinus,
  GitBranchPlus,
  GitFork,
  Grip,
  Link2Off,
  Plus,
  Trash2,
  Variable,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";

// ============ TYPES ============

export interface PathConfig {
  id: string;
  label: string;
  icon: LucideIcon;
  template: string;
  requiredParams: string[];
  /**
   * Optional i18n key resolved at render time via usePathSegment.
   * When present, the translated value replaces `label`. The legacy `label`
   * string remains as fallback for contexts without the hook.
   */
  i18nLabel?: string;
  /** Optional i18n key for the path template string. */
  i18nTemplate?: string;
  /** Optional translation namespace (defaults to the i18n default namespace). */
  i18nNs?: string;
}

export interface PaletteModeConfig {
  id: string;
  label: string;
  title: string;
  icon: LucideIcon;
  path: PathConfig;
  placeholder: string;
  missingParam: string;
}

export interface SelectorConfig {
  modes?: PaletteModeConfig[];
  /** Single path config for selectors without modes */
  path?: PathConfig;
  placeholder?: string;
  missingParam?: string;
  /** Extra labels used by the selector */
  labels?: Record<string, string>;
  /** Extra icons used by the selector */
  icons?: Record<string, LucideIcon>;
  /** Extra placeholders for different states */
  placeholders?: Record<string, string>;
}

// ============ PATH SEGMENT BUILDER ============

/**
 * Builds a path segment from a PathConfig for use in SpotlightSearchBar
 */
export function buildPathSegment(config: PathConfig) {
  return {
    type: "action" as const,
    id: config.id,
    label: config.label,
    icon: config.icon,
    color: "",
    data: {
      template: config.template,
      requiredParams: config.requiredParams,
    },
  };
}

/**
 * Gets the path config for a specific palette mode.
 */
export function getModePath(
  config: SelectorConfig,
  modeId: string
): PathConfig | undefined {
  return config.modes?.find((mode) => mode.id === modeId)?.path;
}

/**
 * Gets a label from the selector config
 */
export function getLabel(config: SelectorConfig, key: string): string {
  return config.labels?.[key] ?? key;
}

/**
 * Gets an icon from the selector config
 */
export function getIcon(
  config: SelectorConfig,
  key: string
): LucideIcon | undefined {
  return config.icons?.[key];
}

// ============ REPO PALETTE CONFIG ============

export const REPO_PALETTE_CONFIG: SelectorConfig = {
  modes: [
    {
      id: "switch",
      label: "Switch",
      title: "Switch to repo (use Tab to navigate tabs)",
      icon: FolderTree,
      path: {
        id: "switch-repo",
        label: "Switch to",
        icon: FolderTree,
        template: "Switch to {workspace}",
        requiredParams: ["workspace"],
        i18nLabel: "selectors.repo.path.switchTo",
        i18nTemplate: "selectors.repo.path.switchToTemplate",
      },
      placeholder: "workspace",
      missingParam: "workspace",
    },
    {
      id: "add",
      label: "Add",
      title: "Add workspace...",
      icon: FolderPlus,
      path: {
        id: "add-workspace",
        label: "Add workspace by",
        icon: FolderPlus,
        template: "Add workspace by {source}",
        requiredParams: ["source"],
        i18nLabel: "selectors.repo.path.addBy",
        i18nTemplate: "selectors.repo.path.addByTemplate",
      },
      placeholder: "source",
      missingParam: "source",
    },
    {
      id: "remove",
      label: "Remove",
      title: "Remove linkage to ORGII",
      icon: Trash2,
      path: {
        id: "remove-repo",
        label: "Remove",
        icon: Trash2,
        template: "Remove {repo} linkage to ORGII",
        requiredParams: ["repo"],
      },
      placeholder: "repo",
      missingParam: "repo",
    },
  ],
};

// ============ CURSOR MODEL PALETTE CONFIG ============

// Static skeleton — the actual label/template is resolved at render
// time via `usePathSegment` overrides using the shared
// `common.filters.*` keys so the search bar reads as
// "Select a model for Cursor..." (matching every other model picker).
export const CURSOR_MODEL_PALETTE_CONFIG: SelectorConfig = {
  path: {
    id: "cursor-model",
    label: "Model",
    icon: Grip,
    template: "Select {model} for Cursor",
    requiredParams: ["model"],
  },
  placeholder: "model",
  missingParam: "model",
};

// ============ DISPATCH CATEGORY PALETTE CONFIG ============

export const DISPATCH_CATEGORY_PALETTE_CONFIG: SelectorConfig = {
  path: {
    id: "session-agent-or-org",
    label: "Session agent",
    icon: Grip,
    template: "Select {agent}",
    requiredParams: ["agent"],
    i18nLabel: "filters.agentOrAgentOrg",
    i18nTemplate: "filters.tplSelectAgentOrOrg",
    i18nNs: "common",
  },
  placeholder: "agent or Agent team",
  missingParam: "agent",
};

// ============ BRANCH PALETTE CONFIG ============

export const BRANCH_PALETTE_CONFIG: SelectorConfig = {
  modes: [
    {
      id: "checkout",
      label: "Checkout",
      title: "Checkout branch",
      icon: GitBranch,
      path: {
        id: "checkout-branch",
        label: "Checkout branch",
        icon: GitBranch,
        template: "Checkout {branch}",
        requiredParams: ["branch"],
        i18nLabel: "selectors.branch.path.checkoutBranch",
        i18nTemplate: "selectors.branch.path.checkoutTemplate",
      },
      placeholder: "branch",
      missingParam: "branch",
    },
    {
      id: "add",
      label: "Add",
      title: "Create new branch",
      icon: Plus,
      path: {
        id: "create-branch",
        label: "Create branch called",
        icon: Plus,
        template: "Create branch called {name}",
        requiredParams: ["name"],
        i18nLabel: "selectors.branch.path.createBranchCalled",
        i18nTemplate: "selectors.branch.path.createBranchCalledTemplate",
      },
      placeholder: "name",
      missingParam: "name",
    },
    {
      id: "add-from",
      label: "Add",
      title: "Create new branch from ref",
      icon: GitBranchPlus,
      path: {
        id: "create-branch-from",
        label: "Create a new branch based on",
        icon: GitBranchPlus,
        template: "Create a new branch based on {branch}",
        requiredParams: ["branch"],
        i18nLabel: "selectors.branch.path.createBranchFrom",
        i18nTemplate: "selectors.branch.path.createBranchFromTemplate",
      },
      placeholder: "branch",
      missingParam: "branch",
    },
    {
      id: "remove",
      label: "Remove",
      title: "Delete branch",
      icon: GitBranchMinus,
      path: {
        id: "remove-branch",
        label: "Delete",
        icon: GitBranchMinus,
        template: "Delete {branch}",
        requiredParams: ["branch"],
        i18nLabel: "selectors.branch.path.delete",
        i18nTemplate: "selectors.branch.path.deleteTemplate",
      },
      placeholder: "branch",
      missingParam: "branch",
    },
  ],
  // Icons used by branch selector items
  icons: {
    branch: GitBranch,
    worktree: GitFork,
    create: Plus,
    createFrom: GitBranchPlus,
    delete: GitBranchMinus,
    detached: Link2Off,
  },
  // Labels for action items and headers
  labels: {
    createNew: "Create new branch...",
    createFrom: "Create new branch from...",
    checkoutDetached: "Checkout detached...",
    deleteBranch: "Delete branch...",
    selectRef: "Select a ref to create the branch from",
    selectDelete: "Select branch to delete",
    otherBranches: "Other Branches",
    inputPlaceholder: "new-branch-name",
  },
  // Placeholders for different tab states
  placeholders: {
    checkout: "branch",
    add: "new branch name",
    addFrom: "existing branch",
    remove: "branch",
  },
};

// ============ EDITOR PALETTE CONFIG ============

/**
 * Mode configuration for EditorPalette.
 *
 * User-facing text (label, description, placeholder) is resolved via i18n
 * under `selectors.editorSpotlight.modes.<id>` at render time — not stored
 * here — so the static config only carries icon, color, and identity.
 */
export interface SpotlightModeConfig {
  id: string;
  icon?: LucideIcon;
  color?: string;
}

export const EDITOR_PALETTE_CONFIG = {
  modes: {
    file: { id: "file", icon: File, color: "primary" },
    command: { id: "command", icon: Command, color: "success" },
    symbol: { id: "symbol", icon: Variable, color: "primary" },
  } as Record<string, SpotlightModeConfig>,
  /** Prefix to mode mapping */
  prefixes: {
    ">": "command",
    "@": "symbol",
  } as Record<string, string>,
  /** Keyboard shortcuts */
  shortcuts: {
    open: getShortcutKeys("quick_open"),
    openCommand: getShortcutKeys("spotlight_open"),
    openSymbol: getShortcutKeys("go_to_symbol"),
    close: getShortcutKeys("spotlight_close"),
    selectNext: getShortcutKeys("spotlight_down"),
    selectPrev: getShortcutKeys("spotlight_up"),
    confirm: getShortcutKeys("spotlight_select"),
  },
};
