/**
 * QuickActionsPanel Component
 *
 * A centered overlay panel displaying keyboard shortcuts and quick actions.
 * Shared UI component used across all work station (CodeEditor, Browser, DatabaseManager).
 *
 * Features:
 * - Centered modal with backdrop
 * - App logo/branding area
 * - List of actions with keyboard shortcuts
 * - Dismissible via ESC or clicking backdrop
 * - Each tool configures its own actions
 *
 * Usage:
 *   <QuickActionsPanel
 *     visible={showQuickActions}
 *     onClose={() => setShowQuickActions(false)}
 *     actions={EDITOR_QUICK_ACTIONS}
 *   />
 */
import { AnimatePresence, motion } from "framer-motion";
import React, { memo, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";

import AnyIcon from "@src/components/AnyIcon";
import {
  KEYBOARD_SHORTCUT_VARIANT,
  KeyboardShortcut,
} from "@src/components/KeyboardShortcut";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { BoxIcon, HugeiconsIcon } from "@src/icons";

import type { QuickAction, QuickActionsPanelProps } from "./types";

// ============================================
// Animation Variants
// ============================================

const backdropVariants = {
  hidden: { opacity: 0 },
  visible: { opacity: 1 },
  exit: { opacity: 0 },
};

const panelVariants = {
  hidden: { opacity: 0, scale: 0.95, y: -10 },
  visible: {
    opacity: 1,
    scale: 1,
    y: 0,
    transition: { type: "spring" as const, damping: 25, stiffness: 300 },
  },
  exit: {
    opacity: 0,
    scale: 0.95,
    y: -10,
    transition: { duration: 0.15 },
  },
};

// ============================================
// Action Item Component
// ============================================

interface ActionItemProps {
  action: QuickAction;
  onAction?: () => void;
}

const ActionItem = memo<ActionItemProps>(({ action, onAction }) => {
  const handleClick = useCallback(() => {
    if (!action.disabled && action.onAction) {
      action.onAction();
    }
    onAction?.();
  }, [action, onAction]);

  return (
    <button
      onClick={handleClick}
      disabled={action.disabled}
      className={`flex w-full items-center justify-between px-4 py-2.5 transition-colors ${
        action.disabled
          ? "cursor-not-allowed opacity-50"
          : `${SURFACE_TOKENS.hover} active:bg-fill-3`
      }`}
    >
      <div className="flex items-center gap-3">
        {action.icon && (
          <AnyIcon
            icon={action.icon}
            size={16}
            strokeWidth={1.5}
            className={action.disabled ? "text-text-4" : "text-text-2"}
          />
        )}
        <span
          className={`text-[14px] font-medium ${
            action.disabled ? "text-text-4" : "text-text-2"
          }`}
        >
          {action.label}
        </span>
      </div>
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
// Logo Component
// ============================================

const AppLogo = memo(() => (
  <div className="flex justify-center pb-6 pt-2">
    <div className="flex h-[120px] w-[120px] items-center justify-center">
      <HugeiconsIcon
        icon={BoxIcon}
        data-icon="box"
        size={80}
        strokeWidth={1}
        className="text-text-4 opacity-40"
        style={{ transform: "rotate(-15deg)" }}
      />
    </div>
  </div>
));

AppLogo.displayName = "AppLogo";

// ============================================
// Main Component
// ============================================

export const QuickActionsPanel = memo<QuickActionsPanelProps>(
  ({ visible, actions, onClose, title, subtitle, showLogo = true }) => {
    // Handle ESC key to close
    useEffect(() => {
      if (!visible) return;

      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          onClose();
        }
      };

      window.addEventListener("keydown", handleKeyDown);
      return () => window.removeEventListener("keydown", handleKeyDown);
    }, [visible, onClose]);

    // Handle backdrop click
    const handleBackdropClick = useCallback(
      (event: React.MouseEvent) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      },
      [onClose]
    );

    // Handle action click (close panel after action)
    const handleActionClick = useCallback(() => {
      onClose();
    }, [onClose]);

    const content = (
      <AnimatePresence>
        {visible && (
          <motion.div
            className="fixed inset-0 z-[9999] flex items-center justify-center"
            variants={backdropVariants}
            initial="hidden"
            animate="visible"
            exit="exit"
            onClick={handleBackdropClick}
          >
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/60" />

            {/* Panel */}
            <motion.div
              className="relative z-10 w-[360px] overflow-hidden rounded-xl border border-border-1 bg-bg-2 shadow-2xl"
              variants={panelVariants}
              initial="hidden"
              animate="visible"
              exit="exit"
              onClick={(event) => event.stopPropagation()}
            >
              {/* Logo area */}
              {showLogo && <AppLogo />}

              {/* Title area (optional) */}
              {(title || subtitle) && (
                <div className="border-b border-border-1 px-4 pb-3">
                  {title && (
                    <h2 className="text-center text-[15px] font-semibold text-text-1">
                      {title}
                    </h2>
                  )}
                  {subtitle && (
                    <p className="mt-1 text-center text-[12px] text-text-3">
                      {subtitle}
                    </p>
                  )}
                </div>
              )}

              {/* Actions list */}
              <div className="flex flex-col py-2">
                {actions.map((action) => (
                  <ActionItem
                    key={action.id}
                    action={action}
                    onAction={handleActionClick}
                  />
                ))}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    );

    return createPortal(content, document.body);
  }
);

QuickActionsPanel.displayName = "QuickActionsPanel";

export default QuickActionsPanel;

// Re-export types
export type { QuickAction, QuickActionsPanelProps } from "./types";
