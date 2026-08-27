/**
 * NoTabsPlaceholder Component
 *
 * Shared empty state for all work station when no tabs are open.
 * Shows tool-specific icon and quick action shortcuts.
 *
 * Usage:
 *   <NoTabsPlaceholder icon="editor" actions={quickActions} />
 */
import {
  ChartNoAxesGantt,
  Code,
  Database,
  GitBranch,
  Globe,
  Layout,
  MessageCircle,
  MessagesSquare,
  Phone,
  Power,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import React, { memo } from "react";

import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
} from "@src/components/KeyboardShortcut";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";

import type { QuickAction } from "../QuickActionsPanel/types";
import { EDITOR_TAB_CANVAS_BG_CLASS } from "../tokens";

// ============================================
// Types
// ============================================

export type PlaceholderIcon =
  | "editor"
  | "source-control"
  | "browser"
  | "database"
  | "project"
  | "simulator"
  | "messages"
  | "chat"
  | "cargo"
  | "canvas";

export interface NoTabsPlaceholderProps {
  /** Tool icon to display */
  icon: PlaceholderIcon;
  /** Optional line shown below the icon (e.g. simulator awaiting Agent) */
  caption?: string;
  /** Quick actions to display (omit for icon-only placeholder) */
  actions?: QuickAction[];
  /** Optional click handler for actions */
  onActionClick?: (action: QuickAction) => void;
  /** Optional contextual content rendered below the shortcut actions */
  children?: React.ReactNode;
}

// ============================================
// Icon Config
// ============================================

const ICON_MAP: Record<PlaceholderIcon, LucideIcon> = {
  editor: Code,
  "source-control": GitBranch,
  browser: Globe,
  database: Database,
  project: ChartNoAxesGantt,
  simulator: Power,
  messages: MessagesSquare,
  chat: MessageCircle,
  cargo: Phone,
  canvas: Layout,
};

// ============================================
// Action Item Component
// ============================================

interface ActionItemProps {
  action: QuickAction;
  onClick?: () => void;
}

const ActionItem = memo<ActionItemProps>(({ action, onClick }) => {
  const handleClick = () => {
    if (!action.disabled && action.onAction) {
      action.onAction();
    }
    onClick?.();
  };

  return (
    <button
      onClick={handleClick}
      disabled={action.disabled}
      className={`flex w-full items-center justify-between rounded-lg px-4 py-2.5 transition-colors ${
        action.disabled
          ? "cursor-not-allowed opacity-50"
          : `${SURFACE_TOKENS.hover} active:bg-fill-3`
      }`}
    >
      <span
        className={`text-[14px] font-medium ${
          action.disabled ? "text-text-4" : "text-text-3"
        }`}
      >
        {action.label}
      </span>
      {action.shortcut && (
        <KeyboardShortcut
          shortcut={action.shortcut}
          variant={KEYBOARD_SHORTCUT_VARIANT.workStation}
        />
      )}
    </button>
  );
});

ActionItem.displayName = "ActionItem";

// ============================================
// Icon Component
// ============================================

interface ToolIconProps {
  icon: PlaceholderIcon;
}

const ToolIcon = memo<ToolIconProps>(({ icon }) => {
  const IconComponent = ICON_MAP[icon];

  return (
    <div className="flex justify-center pb-4">
      <div className="flex h-[100px] w-[100px] items-center justify-center">
        <IconComponent
          size={72}
          strokeWidth={1.25}
          className="text-text-1 opacity-30"
        />
      </div>
    </div>
  );
});

ToolIcon.displayName = "ToolIcon";

// ============================================
// Main Component
// ============================================

export const NoTabsPlaceholder: React.FC<NoTabsPlaceholderProps> = memo(
  ({ icon, caption, actions, onActionClick, children }) => {
    return (
      <div
        className={`flex h-full w-full items-center justify-center ${EDITOR_TAB_CANVAS_BG_CLASS}`}
      >
        <div className="w-[340px]">
          {/* Tool Icon */}
          <ToolIcon icon={icon} />

          {caption ? (
            <p className="mb-4 px-1 text-center text-[13px] leading-snug text-text-3">
              {caption}
            </p>
          ) : null}

          {/* Actions list */}
          {actions && actions.length > 0 && (
            <div className="flex flex-col">
              {actions.map((action) => (
                <ActionItem
                  key={action.id}
                  action={action}
                  onClick={() => onActionClick?.(action)}
                />
              ))}
            </div>
          )}

          {children}
        </div>
      </div>
    );
  }
);

NoTabsPlaceholder.displayName = "NoTabsPlaceholder";

export default NoTabsPlaceholder;
