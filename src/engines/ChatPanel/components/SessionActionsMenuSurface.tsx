import React, {
  createContext,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import DropdownItem from "@src/components/Dropdown/DropdownItem";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

const SubmenuContext = createContext<{
  active: string | null;
  setActive: (id: string | null) => void;
} | null>(null);

const ACTION_SELECTOR =
  'button:not(:disabled), [role="menuitem"]:not([aria-disabled="true"])';

/** One keyboard owner for the menu tree; unmounting removes all its state. */
export function SessionActionsMenuSurface({
  panelRef,
  onClose,
  children,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  panelRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      const submenu = panel.querySelector<HTMLElement>(
        '[data-session-actions-submenu="true"]'
      );
      const scope = submenu ?? panel;
      const rows = Array.from(
        scope.querySelectorAll<HTMLElement>(ACTION_SELECTOR)
      ).filter((row) => row.closest('[role="menu"]') === scope);
      const current = rows.indexOf(document.activeElement as HTMLElement);
      const closeSubmenu = () => {
        const trigger = panel.querySelector<HTMLElement>(
          '[aria-haspopup="menu"][aria-expanded="true"]'
        );
        setActive(null);
        trigger?.focus();
      };

      if (event.key === "Tab") {
        onClose();
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        if (submenu) closeSubmenu();
        else onClose();
        return;
      }
      if (event.key === "ArrowRight" && submenu) {
        event.preventDefault();
        event.stopPropagation();
        closeSubmenu();
        return;
      }
      if (
        event.key === "ArrowLeft" &&
        rows[current]?.getAttribute("aria-haspopup") === "menu"
      ) {
        event.preventDefault();
        event.stopPropagation();
        rows[current].click();
        return;
      }
      if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : event.key === "ArrowDown"
                ? Math.min(current + 1, rows.length - 1)
                : current < 0
                  ? rows.length - 1
                  : Math.max(0, current - 1);
        rows[next]?.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose, panelRef]);

  return (
    <SubmenuContext.Provider value={{ active, setActive }}>
      <div
        {...props}
        ref={panelRef}
        role="menu"
        onMouseOver={(event) => {
          if (!(event.target instanceof Element)) return;
          // Keep the flyout open while crossing the parent's padding into
          // its hover bridge. Only another action row dismisses the group.
          if (
            event.target.closest(ACTION_SELECTOR) &&
            !event.target.closest("[data-session-actions-group]")
          ) {
            setActive(null);
          }
        }}
        onMouseLeave={() => setActive(null)}
      >
        {children}
      </div>
    </SubmenuContext.Provider>
  );
}

export function SessionActionsSubmenu({
  label,
  icon,
  disabled = false,
  dataTestId,
  children,
}: {
  label: string;
  icon: React.ReactNode;
  disabled?: boolean;
  dataTestId: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const context = useContext(SubmenuContext);
  if (!context)
    throw new Error("SessionActionsSubmenu requires a menu surface");
  const { active, setActive } = context;
  const open = active === id;
  const rowRef = useRef<HTMLDivElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Fixed positioning avoids clipping, but the flyout stays in the parent
  // DOM tree so outside-click detection includes it without another listener.
  useLayoutEffect(() => {
    if (!open || !rowRef.current || !flyoutRef.current || !panelRef.current)
      return;
    const row = rowRef.current.getBoundingClientRect();
    const parent = rowRef.current
      .closest('[role="menu"]')!
      .getBoundingClientRect();
    // Measure the visible panel, not the wrapper's padded hover bridge, so
    // the shared inter-panel gap is applied exactly once.
    const panel = panelRef.current.getBoundingClientRect();
    const padding = DROPDOWN_PANEL.viewportPadding;
    const left = Math.max(
      padding,
      parent.left - panel.width - DROPDOWN_PANEL.submenuGap
    );
    const top = Math.max(
      padding,
      Math.min(
        row.top - DROPDOWN_PANEL.padding,
        window.innerHeight - panel.height - padding
      )
    );
    // Set geometry before paint without a second React render. Parent menu
    // repositioning already rerenders this subtree; no extra resize listener.
    flyoutRef.current.style.left = `${left}px`;
    flyoutRef.current.style.top = `${top}px`;
  });

  return (
    <div data-session-actions-group={id}>
      <DropdownItem
        ref={rowRef}
        role="menuitem"
        fullWidth
        tabIndex={0}
        icon={icon}
        disabled={disabled}
        ariaHasPopup="menu"
        ariaExpanded={open}
        dataTestId={dataTestId}
        onMouseEnter={() => {
          if (!disabled) setActive(id);
        }}
        onClick={() => setActive(id)}
        suffix={
          <HugeiconsIcon
            icon={ArrowRight01Icon}
            size={DROPDOWN_ITEM.iconSize}
          />
        }
      >
        {label}
      </DropdownItem>
      {open && (
        <div
          ref={flyoutRef}
          className="fixed"
          style={{ paddingRight: DROPDOWN_PANEL.submenuGap }}
        >
          <div
            ref={panelRef}
            role="menu"
            aria-label={label}
            data-session-actions-submenu="true"
            data-testid={`${dataTestId}-panel`}
            className={`${DROPDOWN_CLASSES.menuPanelBase} ${DROPDOWN_WIDTHS.sidebarMenuClass}`}
          >
            {children}
          </div>
        </div>
      )}
    </div>
  );
}
