/**
 * AppSwitcherChip
 *
 * Pure-view chip showing the current app's icon + label + optional chevron and
 * dropdown panel. Used inline in the Agent Station tab bar.
 *
 * Data wiring lives in the call-site hook:
 * - {@link useSimulatorAppSwitcher} (Agent Station — dock picker)
 *
 * The chip never renders a sidebar collapse toggle — that lives separately in
 * the 40px workstation header.
 */
import { ChevronDown, type LucideIcon } from "lucide-react";
import React, { memo, useEffect } from "react";

import { DROPDOWN_PANEL } from "@src/components/Dropdown/tokens";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { useDropdownEngine } from "@src/hooks/dropdown/useDropdownEngine";

import {
  AppSwitcherDropdownPanel,
  type AppSwitcherMenuItem,
} from "./AppSwitcherDropdownPanel";

export interface AppSwitcherChipProps {
  /** When true, the container is hidden via CSS (avoids mount/unmount flash). */
  hidden?: boolean;
  /** Icon for the active app */
  icon: LucideIcon;
  /** Label for the active app */
  label: string;
  /** Currently active item id (highlighted in the dropdown). */
  activeId: string | null;
  /**
   * Items shown in the dropdown. When empty (or only one item), the chip
   * renders without a chevron and is non-interactive.
   */
  items: readonly AppSwitcherMenuItem[];
  /** Called when the user picks a different item. */
  onSelect: (id: string) => void;
  /** Optional direct click for single-item chips that still need to be interactive. */
  onClick?: () => void;
  /** Stable selector for rendered E2E coverage. */
  testId?: string;
  /**
   * Optional external signal that should close any open dropdown when it
   * changes (e.g. sidebar collapse, route change). The component already
   * closes on outside click and Escape via {@link useDropdownEngine}.
   */
  closeOnChange?: unknown;
}

const AppSwitcherChipComponent: React.FC<AppSwitcherChipProps> = ({
  hidden = false,
  icon: Icon,
  label,
  activeId,
  items,
  onSelect,
  onClick,
  testId,
  closeOnChange,
}) => {
  const {
    isOpen,
    isPositioned,
    toggle,
    close,
    triggerRef,
    panelRef,
    panelPosition,
  } = useDropdownEngine<HTMLDivElement>({
    gap: DROPDOWN_PANEL.triggerGapTight,
    placement: "bottom",
    align: "left",
  });

  useEffect(() => {
    close();
    // closeOnChange is intentionally part of the dependency list so callers
    // can drive a programmatic close on route/state changes.
  }, [closeOnChange, close]);

  const hasDropdown = items.length > 1;
  const isDirectClick = !hasDropdown && !!onClick;

  const containerClass = hidden ? "hidden" : "flex shrink-0 items-center";

  const labelContent = (
    <>
      {/* 20×20 icon container so the chip's icon glyph rectangle matches
          the 20×20 sidebar toggle button in the global tab-header strip
          directly below — keeps the two icons in the same column. */}
      <span className="flex h-5 w-5 shrink-0 items-center justify-center">
        <Icon size={14} strokeWidth={1.75} className="shrink-0 text-text-1" />
      </span>
      <span className="min-w-0 truncate text-left text-[13px] font-medium text-text-1">
        {label}
      </span>
      {hasDropdown ? (
        <ChevronDown
          size={12}
          className={`shrink-0 text-text-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
        />
      ) : null}
    </>
  );

  const openClass = isOpen ? SURFACE_TOKENS.selected : "";
  const innerInteractiveClass = `flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-lg px-1 transition-colors ${SURFACE_TOKENS.hover} ${openClass}`;
  const innerStaticClass =
    "flex h-8 min-w-0 items-center gap-1.5 rounded-lg px-1";

  return (
    <>
      <div ref={triggerRef} className={containerClass}>
        {hasDropdown || isDirectClick ? (
          <button
            type="button"
            className={innerInteractiveClass}
            onClick={hasDropdown ? toggle : onClick}
            title={label}
            aria-expanded={hasDropdown ? isOpen : undefined}
            data-testid={testId}
          >
            {labelContent}
          </button>
        ) : (
          <div className={innerStaticClass} data-testid={testId}>
            {labelContent}
          </div>
        )}
      </div>

      {hasDropdown && isOpen && isPositioned && (
        <AppSwitcherDropdownPanel
          panelRef={panelRef}
          panelPosition={panelPosition}
          items={items}
          activeId={activeId}
          onSelect={onSelect}
          onClose={close}
        />
      )}
    </>
  );
};

export const AppSwitcherChip = memo(AppSwitcherChipComponent);
AppSwitcherChip.displayName = "AppSwitcherChip";
