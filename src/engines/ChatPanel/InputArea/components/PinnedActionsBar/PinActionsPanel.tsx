/**
 * PinActionsPanel
 *
 * A floating search panel opened by the "..." button in PinnedActionsBar.
 * Lists all available slash items (skills + MCP tools + builtins) and lets
 * the user pin or unpin them. Renders via a React portal so it's never
 * clipped by the parent's overflow.
 */
import React, { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import DropdownSearch from "@src/components/Dropdown/DropdownSearch";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import FileTreePreview from "@src/components/FileTreePreview";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { ArrowUp02Icon, HugeiconsIcon, PinIcon, PinOffIcon } from "@src/icons";
import type { PinnedAction } from "@src/store/session/pinnedActionsAtom";
import type { SlashItem } from "@src/types/extensions";
import { fuzzyMatch, fuzzyScore } from "@src/util/search/fuzzy";
import { getViewportSize } from "@src/util/ui/window/viewport";

/** Skill name for the setup-repo skill that is superseded by the Setup Repo action pill. */
const SETUP_REPO_SKILL_NAME = "setup-repo";

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Stable identity key for a pinned action or slash item.
 *
 * Skills are keyed by `skillName` (the backend token) rather than `source`
 * (the display group label) because the group label can change across
 * installs/renames while `skillName` stays constant.  Using `source` in the
 * key was causing pinned skills to never match their available-item
 * counterpart whenever the resolved group label differed from the label that
 * was originally persisted.
 *
 * Tools are keyed by server name + tool name (both stable identifiers).
 * Built-in actions are keyed by category + name.
 */
function actionKey(a: PinnedAction | SlashItem): string {
  if (a.category === "skill") {
    // skillName is the canonical identifier; fall back to name if absent
    // (covers legacy stored PinnedActions that pre-date the skillName field).
    const token = a.skillName ?? a.name;
    return `skill|${token}`;
  }
  if (a.category === "tool") {
    return `tool|${a.serverName ?? a.source}|${a.name}`;
  }
  // "action" and any future categories
  return `${a.category}|${a.name}`;
}

function slashItemToAction(item: SlashItem): PinnedAction {
  return {
    name: item.name,
    skillName: item.skillName,
    skillPath: item.skillPath,
    category: item.category,
    source: item.source,
    serverName: item.serverName,
  };
}

// ── component ─────────────────────────────────────────────────────────────────

interface PinActionsPanelProps {
  /** Whether the panel is visible. */
  visible: boolean;
  /** All available slash items to choose from. */
  availableItems: SlashItem[];
  /** Currently pinned actions. */
  pinnedActions: PinnedAction[];
  /** Called when the user pins or unpins an item. */
  onTogglePin: (action: PinnedAction) => void;
  /** Called when the user inserts an item directly into the composer. */
  onInsert: (action: PinnedAction) => void;
  /** Called when the user clicks the "Unpin all" footer action. */
  onUnpinAll: () => void;
  /** Called when the panel should close. */
  onClose: () => void;
  /** Whether items are still loading. */
  loading: boolean;
  /**
   * Ref to the button that toggles this panel. When provided, clicks on the
   * trigger button are excluded from the click-outside handler so the parent's
   * own toggle logic fires without the panel immediately re-opening.
   */
  triggerRef?: React.RefObject<HTMLButtonElement | null>;
  /**
   * Horizontal alignment of the panel relative to the trigger button.
   * Defaults to "right" so the panel right-aligns to the "…" button when
   * pills sit to its left. When the "…" button is the leftmost element in
   * the bar (no other pills), callers should pass "left" so the panel
   * extends rightward from the button instead of floating to its left.
   */
  align?: "left" | "right";
}

const PinActionsPanel: React.FC<PinActionsPanelProps> = memo(
  ({
    visible,
    availableItems,
    pinnedActions,
    onTogglePin,
    onInsert,
    onUnpinAll,
    onClose,
    loading,
    triggerRef,
    align = "right",
  }) => {
    const { t } = useTranslation("sessions");
    const [query, setQuery] = useState("");
    const inputRef = useRef<HTMLInputElement>(null);

    // Reset query and autofocus whenever panel opens.
    useEffect(() => {
      if (visible) {
        requestAnimationFrame(() => {
          setQuery("");
          inputRef.current?.focus();
        });
      }
    }, [visible]);

    const pinnedKeys = new Set(pinnedActions.map(actionKey));

    // Exclude the `setup-repo` skill because the `Setup Repo` action pill
    // already covers it.  Showing both creates a confusing duplicate.
    const displayItems = availableItems.filter(
      (item) =>
        !(item.category === "skill" && item.skillName === SETUP_REPO_SKILL_NAME)
    );

    const filteredItems: SlashItem[] = query
      ? displayItems
          .filter(
            (item) =>
              fuzzyMatch(query, item.name) ||
              fuzzyMatch(query, item.description)
          )
          .sort((a, b) => fuzzyScore(query, b.name) - fuzzyScore(query, a.name))
      : displayItems;
    const workspaceSkillItems = filteredItems.filter(
      (item) => item.category === "skill" && item.skillScope === "workspace"
    );
    const userSkillItems = filteredItems.filter(
      (item) => item.category === "skill" && item.skillScope !== "workspace"
    );
    const nonSkillItems = filteredItems.filter(
      (item) => item.category !== "skill"
    );

    const handleToggle = useCallback(
      (item: SlashItem) => {
        onTogglePin(slashItemToAction(item));
      },
      [onTogglePin]
    );

    const handleInsert = useCallback(
      (item: SlashItem) => {
        onInsert(slashItemToAction(item));
      },
      [onInsert]
    );

    const { isPositioned, panelRef, panelPosition, keyboard } =
      useDropdownEngine<HTMLButtonElement, SlashItem>({
        open: visible,
        onOpenChange: (open) => {
          if (!open) onClose();
        },
        anchorRef: triggerRef,
        placement: "top",
        align,
        gap: DROPDOWN_PANEL.triggerGapTight,
        listNavigation: {
          items: filteredItems,
          onSelect: handleToggle,
          initialSelectedIndex: -1,
        },
      });

    const activeItem =
      keyboard.selectedIndex >= 0
        ? filteredItems[keyboard.selectedIndex]
        : null;
    const activeSkillItem =
      activeItem?.category === "skill" && activeItem.skillPath
        ? activeItem
        : null;

    if (!visible || !isPositioned) return null;

    const PANEL_WIDTH = 240;
    const VIEWPORT_PADDING = 8;
    const { width: vw } = getViewportSize();

    // Anchor to whichever edge the engine populated. When `align="right"`,
    // `panelPosition.right` is set (distance from viewport's right edge to the
    // trigger's right edge) and we hand it straight to CSS — this avoids
    // round-tripping through `left` arithmetic that goes wrong under CSS
    // `zoom`, where viewport-width and getBoundingClientRect() can disagree on
    // their coordinate space.  Sibling dropdowns (FollowModeDropdown,
    // PlaybackSpeedInline) use the same direct-edge pattern.
    let positionStyle: React.CSSProperties;
    if (panelPosition.right !== undefined) {
      const clampedRight = Math.max(
        VIEWPORT_PADDING,
        Math.min(panelPosition.right, vw - PANEL_WIDTH - VIEWPORT_PADDING)
      );
      positionStyle = { right: clampedRight };
    } else {
      const clampedLeft = Math.max(
        VIEWPORT_PADDING,
        Math.min(panelPosition.left, vw - PANEL_WIDTH - VIEWPORT_PADDING)
      );
      positionStyle = { left: clampedLeft };
    }

    const renderItem = (item: SlashItem) => {
      const key = actionKey(item);
      const isPinned = pinnedKeys.has(key);
      const renderKey = `${key}|${item.skillPath ?? item.source}`;
      return (
        <button
          key={renderKey}
          type="button"
          className={`${DROPDOWN_CLASSES.menuControlItem} min-w-0`}
          {...keyboard.getItemProps(filteredItems.indexOf(item))}
        >
          <div className="flex min-w-0 items-center">
            <span className="truncate text-[12px] font-medium text-text-1">
              {item.name}
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-2">
            <span
              role="button"
              tabIndex={-1}
              aria-label={t("input.pinnedActions.insert")}
              className="text-text-3 transition-colors duration-150 hover:text-primary-6"
              onClick={(event) => {
                event.stopPropagation();
                handleInsert(item);
              }}
            >
              <HugeiconsIcon
                icon={ArrowUp02Icon}
                data-icon="arrow-up"
                size={DROPDOWN_ITEM.iconSize}
                strokeWidth={2}
              />
            </span>
            <span
              className={`transition-colors duration-150 ${
                isPinned ? "text-primary-6" : "text-text-3 hover:text-text-2"
              }`}
            >
              {isPinned ? (
                <HugeiconsIcon
                  icon={PinOffIcon}
                  data-icon="pin-off"
                  size={DROPDOWN_ITEM.iconSize}
                  strokeWidth={1.75}
                />
              ) : (
                <HugeiconsIcon
                  icon={PinIcon}
                  data-icon="pin"
                  size={DROPDOWN_ITEM.iconSize}
                  strokeWidth={1.75}
                />
              )}
            </span>
          </span>
        </button>
      );
    };

    const renderSection = (label: string, sectionItems: SlashItem[]) => {
      if (sectionItems.length === 0) return null;
      return (
        <React.Fragment key={label}>
          <div className={`${DROPDOWN_CLASSES.sectionLabel} first:pt-1`}>
            {label}
          </div>
          {sectionItems.map(renderItem)}
        </React.Fragment>
      );
    };

    return createPortal(
      <div
        ref={panelRef}
        className={`fixed z-[99999] flex flex-col ${DROPDOWN_CLASSES.menuPanelWithHeader}`}
        style={{
          top: panelPosition.top,
          bottom: panelPosition.bottom,
          ...positionStyle,
          width: PANEL_WIDTH,
        }}
      >
        {activeSkillItem?.skillPath && (
          <div
            className="absolute left-full top-0 ml-2"
            style={{ pointerEvents: "auto" }}
          >
            <FileTreePreview path={activeSkillItem.skillPath} itemType="file" />
          </div>
        )}

        {/* Search header */}
        <DropdownSearch
          ref={inputRef}
          type="text"
          value={query}
          onChange={setQuery}
          placeholder={t("input.pinnedActions.searchPlaceholder")}
        />

        {/* List */}
        <div
          className={`max-h-[280px] overflow-y-auto scrollbar-hide ${DROPDOWN_CLASSES.itemsColumnBelowSearch}`}
        >
          {loading && filteredItems.length === 0 && (
            <div className={DROPDOWN_CLASSES.listMessage}>
              {t("input.pinnedActions.loading")}
            </div>
          )}
          {!loading && filteredItems.length === 0 && (
            <div className={DROPDOWN_CLASSES.listMessage}>
              {t("input.pinnedActions.empty")}
            </div>
          )}
          {renderSection(
            t("creator.slashMenu.workspaceSkills", {
              defaultValue: "Workspace Skills",
            }),
            workspaceSkillItems
          )}
          {renderSection(
            t("creator.slashMenu.userSkills", { defaultValue: "User Skills" }),
            userSkillItems
          )}
          {nonSkillItems.map(renderItem)}
        </div>

        {/* Footer */}
        {pinnedActions.length > 0 && (
          <div className={DROPDOWN_CLASSES.footerContainer}>
            <button
              type="button"
              onClick={onUnpinAll}
              className={`${DROPDOWN_CLASSES.menuActionItem} min-w-0`}
              data-dropdown-keyboard-skip="true"
            >
              <span className="truncate text-[12px] font-medium">
                {t("input.pinnedActions.unpinAll")}
              </span>
            </button>
          </div>
        )}
      </div>,
      document.body
    );
  }
);

PinActionsPanel.displayName = "PinActionsPanel";

export { actionKey, slashItemToAction };
export default PinActionsPanel;
