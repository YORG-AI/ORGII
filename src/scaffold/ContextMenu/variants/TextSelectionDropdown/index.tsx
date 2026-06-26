/**
 * TextSelectionDropdown Component
 *
 * A floating dropdown menu that appears when text is selected in terminal or browser views.
 * Provides options to "Ask Agent" or "Add to Session Context".
 *
 * Features:
 * - High z-index (99999) for visibility above all other elements
 * - Two-level menu: main options and session selector
 * - Keyboard navigation support
 * - Smooth animations
 *
 * @example
 * <TextSelectionDropdown
 *   visible={isVisible}
 *   position={{ x: 100, y: 200 }}
 *   selectedText="selected content"
 *   source="terminal"
 *   onClose={handleClose}
 *   onAskAgent={handleAskAgent}
 *   onAddToContext={handleAddToContext}
 * />
 */
import { useAtomValue } from "jotai";
import { History, Plus } from "lucide-react";
import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
} from "@src/components/Dropdown/tokens";
import { Session, recentSessionsAtom } from "@src/store/session";
import { stripPillReferences } from "@src/util/session/stripPillReferences";
import { getViewportSize } from "@src/util/ui/window/viewport";

import {
  DropdownAction,
  EDITOR_MENU_ITEMS,
  ICON_CONFIG,
  KEYBOARD_CONFIG,
  MENU_ITEMS,
  STYLE_CONFIG,
  SessionItem,
} from "./config";
import { TextSelectionDropdownProps } from "./types";

// ============================================
// Sub-components
// ============================================

interface MenuItemRowProps {
  icon: React.ReactNode;
  label: string;
  hasArrow?: boolean;
  isActive?: boolean;
  onClick?: () => void;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

const MenuItemRow: React.FC<MenuItemRowProps> = memo(
  ({
    icon,
    label,
    hasArrow = false,
    isActive = false,
    onClick,
    onMouseEnter,
    onMouseLeave,
  }) => (
    <div
      className={`${DROPDOWN_CLASSES.item} justify-between ${
        isActive ? DROPDOWN_CLASSES.itemActive : DROPDOWN_CLASSES.itemHover
      }`}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      <div className="flex items-center gap-2">
        {icon}
        <span>{label}</span>
      </div>
      {hasArrow && (
        <ICON_CONFIG.arrow
          size={DROPDOWN_ITEM.iconSize}
          className="text-text-3"
          strokeWidth={1.75}
        />
      )}
    </div>
  )
);

MenuItemRow.displayName = "MenuItemRow";

interface SessionSelectorPanelProps {
  sessions: SessionItem[];
  activeIndex: number;
  onSelect: (sessionId: string | null) => void;
  onHover: (index: number) => void;
  onHoverEnd: () => void;
  onBack: () => void;
}

const SessionSelectorPanel: React.FC<SessionSelectorPanelProps> = memo(
  ({ sessions, activeIndex, onSelect, onHover, onHoverEnd, onBack }) => {
    const itemRefs = useRef<(HTMLDivElement | null)[]>([]);

    // Scroll active item into view
    useEffect(() => {
      if (itemRefs.current[activeIndex]) {
        itemRefs.current[activeIndex]?.scrollIntoView({
          block: "nearest",
          behavior: "smooth",
        });
      }
    }, [activeIndex]);

    return (
      <div
        className={DROPDOWN_CLASSES.panel}
        style={{ width: STYLE_CONFIG.secondLayerWidth }}
      >
        <div className={DROPDOWN_CLASSES.searchContainer}>
          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={onBack}
            className="flex h-[24px] w-[24px] items-center justify-center rounded-[4px] text-text-2 hover:bg-fill-1"
          >
            <ICON_CONFIG.arrowBack
              size={DROPDOWN_ITEM.iconSize}
              strokeWidth={1.75}
            />
          </button>
          <span className="text-[13px] font-medium text-text-1">
            Select Session
          </span>
        </div>

        {/* Session list */}
        <div
          className={DROPDOWN_CLASSES.optionsContainer}
          style={{ maxHeight: STYLE_CONFIG.maxHeight }}
        >
          {/* New Session option - always first */}
          <div
            ref={(element) => {
              itemRefs.current[0] = element;
            }}
            className={`${DROPDOWN_CLASSES.item} ${
              activeIndex === 0
                ? DROPDOWN_CLASSES.itemActive
                : DROPDOWN_CLASSES.itemHover
            }`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onSelect(null)}
            onMouseEnter={() => onHover(0)}
            onMouseLeave={onHoverEnd}
          >
            <Plus size={DROPDOWN_ITEM.iconSize} className="text-text-2" />
            <span className="text-[13px] text-text-1">New Session</span>
          </div>

          {/* Divider */}
          {sessions.length > 0 && (
            <div className={DROPDOWN_CLASSES.menuSeparator} />
          )}

          {/* Existing sessions */}
          {sessions.map((session, index) => {
            const itemIndex = index + 1; // +1 for New Session
            return (
              <div
                key={session.sessionId}
                ref={(element) => {
                  itemRefs.current[itemIndex] = element;
                }}
                className={`${DROPDOWN_CLASSES.item} ${
                  activeIndex === itemIndex
                    ? DROPDOWN_CLASSES.itemActive
                    : DROPDOWN_CLASSES.itemHover
                }`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => onSelect(session.sessionId)}
                onMouseEnter={() => onHover(itemIndex)}
                onMouseLeave={onHoverEnd}
              >
                <History
                  size={DROPDOWN_ITEM.iconSize}
                  className="flex-shrink-0 text-text-2"
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-text-1">
                  {session.name}
                </span>
              </div>
            );
          })}

          {/* Empty state */}
          {sessions.length === 0 && (
            <div className={DROPDOWN_CLASSES.listMessage}>
              No recent sessions
            </div>
          )}
        </div>
      </div>
    );
  }
);

SessionSelectorPanel.displayName = "SessionSelectorPanel";

// ============================================
// Utility Functions
// ============================================

function mapSessionToItem(session: Session): SessionItem {
  return {
    sessionId: session.session_id,
    name: stripPillReferences(
      session.name || session.user_input?.slice(0, 50) || "Untitled Session"
    ),
  };
}

// ============================================
// Main Component
// ============================================

const TextSelectionDropdown: React.FC<TextSelectionDropdownProps> = ({
  visible,
  position,
  selectedText,
  source,
  onClose,
  onAskAgent,
  onAddToContext,
  onAddFile,
  onAddLines,
  lineRange,
  className = "",
}) => {
  const { t } = useTranslation("common");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const calculatedPositionRef = useRef(position);

  // State
  const [activeIndex, setActiveIndex] = useState(-1);
  const [keyboardNavigated, setKeyboardNavigated] = useState(false);
  const [showSessionSelector, setShowSessionSelector] = useState(false);
  const [sessionActiveIndex, setSessionActiveIndex] = useState(0);
  const [safePosition, setSafePosition] = useState(position);

  const resetActiveIndex = useCallback(() => {
    setKeyboardNavigated(false);
    setActiveIndex(-1);
  }, []);
  const resetSessionActiveIndex = useCallback(() => {
    setKeyboardNavigated(false);
    setSessionActiveIndex(-1);
  }, []);

  // Get recent sessions from store
  const recentSessions = useAtomValue(recentSessionsAtom);
  const sessionItems: SessionItem[] = recentSessions.map(mapSessionToItem);

  // Select menu items based on source
  const menuItems = source === "editor" ? EDITOR_MENU_ITEMS : MENU_ITEMS;

  // Phase 1 (layout): hide the dropdown and compute the clamped position into
  // a ref. Direct DOM opacity mutation avoids setState-in-layoutEffect.
  // Under CSS zoom, position coords come from MouseEvent.clientX/Y ÷ uiScale
  // (layout pixels). Both getBoundingClientRect() and getViewportSize() return
  // values in the same layout-pixel space, so clamping is correct at any zoom.
  useLayoutEffect(() => {
    if (!dropdownRef.current) return;

    // Hide immediately so the browser never paints the dropdown at a stale or
    // unclamped position while the new safe coords are being computed.
    dropdownRef.current.style.opacity = "0";

    if (!visible) return;

    const dropdownRect = dropdownRef.current.getBoundingClientRect();
    const { width: viewportWidth, height: viewportHeight } = getViewportSize();
    const padding = 10;

    let safeX = position.x;
    let safeY = position.y;

    // Prevent overflow right
    if (safeX + dropdownRect.width + padding > viewportWidth) {
      safeX = viewportWidth - dropdownRect.width - padding;
    }

    // Prevent overflow bottom
    if (safeY + dropdownRect.height + padding > viewportHeight) {
      safeY = viewportHeight - dropdownRect.height - padding;
    }

    // Prevent overflow left/top
    safeX = Math.max(padding, safeX);
    safeY = Math.max(padding, safeY);

    calculatedPositionRef.current = { x: safeX, y: safeY };
  }, [visible, position]);

  // Phase 2 (effect): commit the clamped position to state and reveal the
  // dropdown. Runs after the layout phase above, so safePosition is already
  // correct when the browser first paints the visible dropdown.
  useEffect(() => {
    if (!visible) return;
    setSafePosition(calculatedPositionRef.current);
    if (dropdownRef.current) {
      dropdownRef.current.style.opacity = "";
    }
  }, [visible, position]);

  // Handle menu item click
  const handleMenuClick = useCallback(
    (action: DropdownAction) => {
      if (action === "ask-agent") {
        onAskAgent?.(selectedText);
        onClose();
      } else if (action === "add-to-chat") {
        // Direct insert into chat composer — no session picker
        onAddToContext?.(selectedText, null);
        onClose();
      } else if (action === "add-to-context") {
        setShowSessionSelector(true);
        setSessionActiveIndex(0);
      } else if (action === "add-file") {
        if (onAddFile) {
          onAddFile();
        } else {
          onAddToContext?.(selectedText, null);
        }
        onClose();
      } else if (action === "add-lines") {
        if (onAddLines) {
          onAddLines();
        } else {
          onAskAgent?.(selectedText);
        }
        onClose();
      }
    },
    [selectedText, onAskAgent, onAddToContext, onAddFile, onAddLines, onClose]
  );

  // Handle session selection
  const handleSessionSelect = useCallback(
    (sessionId: string | null) => {
      onAddToContext?.(selectedText, sessionId);
      onClose();
    },
    [selectedText, onAddToContext, onClose]
  );

  // Handle back button
  const handleBack = useCallback(() => {
    setShowSessionSelector(false);
    setActiveIndex(1); // Return to "Add to Session Context"
  }, []);

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (!visible) return;

      const key = event.key;

      if (showSessionSelector) {
        // Session selector navigation
        const totalItems = sessionItems.length + 1; // +1 for New Session

        if (key === KEYBOARD_CONFIG.up) {
          event.preventDefault();
          setKeyboardNavigated(true);
          setSessionActiveIndex(
            (previous) => (previous - 1 + totalItems) % totalItems
          );
        } else if (key === KEYBOARD_CONFIG.down) {
          event.preventDefault();
          setKeyboardNavigated(true);
          setSessionActiveIndex((previous) => (previous + 1) % totalItems);
        } else if (key === KEYBOARD_CONFIG.enter) {
          event.preventDefault();
          if (sessionActiveIndex === 0) {
            handleSessionSelect(null);
          } else {
            const session = sessionItems[sessionActiveIndex - 1];
            handleSessionSelect(session.sessionId);
          }
        } else if (
          key === KEYBOARD_CONFIG.left ||
          key === KEYBOARD_CONFIG.escape
        ) {
          event.preventDefault();
          handleBack();
        }
      } else {
        // Main menu navigation
        if (key === KEYBOARD_CONFIG.up) {
          event.preventDefault();
          setKeyboardNavigated(true);
          setActiveIndex((previous) => {
            // If no item is active, start from last item
            if (previous < 0) return menuItems.length - 1;
            return (previous - 1 + menuItems.length) % menuItems.length;
          });
        } else if (key === KEYBOARD_CONFIG.down) {
          event.preventDefault();
          setKeyboardNavigated(true);
          setActiveIndex((previous) => {
            // If no item is active, start from first item
            if (previous < 0) return 0;
            return (previous + 1) % menuItems.length;
          });
        } else if (
          key === KEYBOARD_CONFIG.enter ||
          key === KEYBOARD_CONFIG.right
        ) {
          event.preventDefault();
          // If no item is active, default to first item (index 0)
          const indexToUse = activeIndex >= 0 ? activeIndex : 0;
          const item = menuItems[indexToUse];
          handleMenuClick(item.id);
        } else if (key === KEYBOARD_CONFIG.escape) {
          event.preventDefault();
          onClose();
        }
      }
    },
    [
      visible,
      showSessionSelector,
      sessionItems,
      sessionActiveIndex,
      activeIndex,
      menuItems,
      handleMenuClick,
      handleSessionSelect,
      handleBack,
      onClose,
    ]
  );

  // Reset state when visibility changes to false
  const previousVisibleRef = useRef(visible);
  useEffect(() => {
    const wasVisible = previousVisibleRef.current;
    previousVisibleRef.current = visible;

    if (wasVisible && !visible) {
      // Only reset when transitioning from visible to hidden
      // Schedule state updates in next tick to avoid setState-in-effect warning
      Promise.resolve().then(() => {
        setActiveIndex(-1);
        setKeyboardNavigated(false);
        setShowSessionSelector(false);
        setSessionActiveIndex(0);
      });
    }
  }, [visible]);

  // Click outside handler
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (dropdownRef.current && !dropdownRef.current.contains(target)) {
        onClose();
      }
    };

    if (visible) {
      document.addEventListener("mousedown", handleClickOutside);
    }

    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [visible, onClose]);

  if (!visible) return null;

  const dropdownContent = (
    <div
      ref={dropdownRef}
      className={`text-selection-dropdown fixed ${className}`}
      data-dropdown-keyboard-mode={keyboardNavigated ? "true" : undefined}
      style={{
        left: safePosition.x,
        top: safePosition.y,
        zIndex: STYLE_CONFIG.zIndex,
      }}
      onKeyDown={handleKeyDown}
      onMouseDown={(event) => event.preventDefault()}
      tabIndex={-1}
    >
      {showSessionSelector ? (
        <SessionSelectorPanel
          sessions={sessionItems}
          activeIndex={keyboardNavigated ? sessionActiveIndex : -1}
          onSelect={handleSessionSelect}
          onHover={(index) => {
            setKeyboardNavigated(false);
            setSessionActiveIndex(index);
          }}
          onHoverEnd={resetSessionActiveIndex}
          onBack={handleBack}
        />
      ) : (
        <div
          className={DROPDOWN_CLASSES.panel}
          style={{ width: STYLE_CONFIG.dropdownWidth }}
        >
          <div className={DROPDOWN_CLASSES.itemsColumnPadded}>
            {menuItems.map((item, index) => {
              const IconComponent = item.icon;
              let label: string;
              if (item.id === "add-to-chat") {
                label = t("selectionMenu.addToChat");
              } else if (item.id === "add-file") {
                label = t("selectionMenu.addThisFile");
              } else if (item.id === "add-lines") {
                label = t("selectionMenu.addLines", {
                  from: lineRange?.fromLine ?? 0,
                  to: lineRange?.toLine ?? 0,
                });
              } else {
                label = item.label;
              }

              return (
                <MenuItemRow
                  key={item.id}
                  icon={
                    <IconComponent
                      size={DROPDOWN_ITEM.iconSize}
                      className="text-text-2"
                      strokeWidth={1.75}
                    />
                  }
                  label={label}
                  hasArrow={item.hasSecondLayer}
                  isActive={keyboardNavigated && activeIndex === index}
                  onClick={() => handleMenuClick(item.id)}
                  onMouseEnter={() => {
                    setKeyboardNavigated(false);
                    setActiveIndex(index);
                  }}
                  onMouseLeave={resetActiveIndex}
                />
              );
            })}
          </div>
        </div>
      )}
    </div>
  );

  // Render in portal to ensure highest z-index
  return createPortal(dropdownContent, document.body);
};

export default memo(TextSelectionDropdown);
