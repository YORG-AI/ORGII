/**
 * Spotlight Action Definition Types
 *
 * Shared TypeScript types for the static spotlight action tables defined in
 * the sibling `spotlightActionDefinitions.*.ts` modules. Split out of
 * `spotlightActionDefinitions.ts` so the type surface can be imported
 * without pulling in the action tables (and their icon imports).
 */
import type { ActionId } from "@src/ActionSystem";

import type { SpotlightItem } from "../../types";

// ============================================
// Types
// ============================================

export type SpotlightStaticActionId =
  | "open-session-creator"
  | "create-project"
  | "create-work-item"
  | "search-agent-sessions"
  | "search-all-sessions"
  | "open-agent-control"
  | "switch-workspace"
  | "switch-branch"
  | "add-workspace"
  | "create-multi-repo-workspace"
  | "toggle-sidebar"
  | "set-system-theme"
  | "set-light-theme"
  | "set-dark-theme"
  | "set-high-contrast-theme"
  | "set-my-station-chat-left"
  | "set-my-station-chat-right"
  | "set-agent-station-chat-left"
  | "set-agent-station-chat-right"
  | "enable-chat-pagination"
  | "disable-chat-pagination"
  | "use-model-picker-spotlight"
  | "use-model-picker-dropdown"
  | "set-workstation-sidebar-left"
  | "set-workstation-sidebar-right"
  | "enable-dock-auto-hide"
  | "disable-dock-auto-hide"
  | "open-my-station"
  | "open-agent-station"
  | "open-kanban"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-workstation-sidebar"
  | "toggle-bottom-panel"
  | "toggle-workstation-chat-focus"
  | "toggle-workstation-chat-panel"
  | "open-search-sidebar"
  | "open-source-control-tab"
  | "open-terminal-tab"
  | "detect-update";

export type SpotlightStaticActionFallback =
  | "open-session-creator"
  | "create-project"
  | "create-work-item"
  | "search-agent-sessions"
  | "search-all-sessions"
  | "agent-control"
  | "workspace-switch"
  | "workspace-add"
  | "workspace-create"
  | "branch-picker"
  | "toggle-sidebar"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-workstation-sidebar"
  | "toggle-bottom-panel"
  | "toggle-chat-focus"
  | "toggle-chat-panel"
  | "open-my-station"
  | "open-agent-station"
  | "open-kanban"
  | "open-search-sidebar"
  | "open-source-control-tab"
  | "open-terminal-tab"
  | "detect-update";

export type SpotlightEditorActionId =
  | "go-to-editor-file"
  | "run-editor-command"
  | "go-to-editor-symbol";

export interface SpotlightStaticActionDefinition {
  id: SpotlightStaticActionId;
  labelKey: string;
  icon: SpotlightItem["icon"];
  keywords: string[];
  shortcut?: string;
  actionId: ActionId;
  payload: Record<string, unknown>;
  fallback?: SpotlightStaticActionFallback;
  opensSecondLevel?: boolean;
  closeOnSuccess: boolean;
}

export interface SpotlightEditorActionDefinition {
  id: SpotlightEditorActionId;
  modeKey: "file" | "command" | "symbol";
  labelKey: "label" | "hintLabel";
  prefix: string;
  shortcut: string;
}
