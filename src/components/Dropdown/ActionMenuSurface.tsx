import React, {
  createContext,
  useCallback,
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
import { useMenuHoverGrace } from "@src/hooks/dropdown/useMenuHoverGrace";
import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";

const SubmenuContext = createContext<{
  active: string | null;
  setActive: (id: string | null) => void;
  hoverSubmenu: (id: string) => void;
  cancelHover: () => void;
  fitSubmenus: boolean;
} | null>(null);

const ACTION_SELECTOR =
  'button:not(:disabled), [role="menuitem"]:not([aria-disabled="true"]), [role="menuitemradio"]:not([aria-disabled="true"])';

/** One keyboard owner for the menu tree; unmounting removes all its state. */
export function ActionMenuSurface({
  panelRef,
  onClose,
  children,
  fitSubmenus = false,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & {
  panelRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
  /** Flip flyouts when a leading-edge trigger leaves no room on the left. */
  fitSubmenus?: boolean;
}) {
  const [active, setActiveId] = useState<string | null>(null);
  const { cancel: cancelHover, schedule: scheduleHover } = useMenuHoverGrace(
    active !== null
  );
  const setActive = useCallback(
    (id: string | null) => {
      cancelHover();
      setActiveId(id);
    },
    [cancelHover]
  );
  const hoverSubmenu = (id: string) => {
    if (active !== null && active !== id) {
      scheduleHover(() => setActive(id));
    } else {
      setActive(id);
    }
  };

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey)
        return;
      cancelHover();
      const submenu = panel.querySelector<HTMLElement>(
        '[data-action-menu-submenu="true"]'
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
      const submenuCloseKey =
        submenu?.dataset.actionMenuSide === "right"
          ? "ArrowLeft"
          : "ArrowRight";
      if (event.key === submenuCloseKey && submenu) {
        event.preventDefault();
        event.stopPropagation();
        closeSubmenu();
        return;
      }
      if (
        (event.key === "ArrowLeft" ||
          (fitSubmenus && event.key === "ArrowRight")) &&
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
  }, [cancelHover, fitSubmenus, onClose, panelRef, setActive]);

  return (
    <SubmenuContext.Provider
      value={{ active, setActive, hoverSubmenu, cancelHover, fitSubmenus }}
    >
      <div
        {...props}
        ref={panelRef}
        role="menu"
        onMouseEnter={cancelHover}
        onPointerDownCapture={cancelHover}
        onMouseOver={(event) => {
          if (!(event.target instanceof Element)) return;
          // Crossing another row on a diagonal must not immediately dismiss
          // the flyout. Entering it cancels this pending hover transition.
          if (
            event.target.closest(ACTION_SELECTOR) &&
            !event.target.closest("[data-action-menu-group]")
          ) {
            scheduleHover(() => setActive(null));
          }
        }}
        onMouseLeave={() => scheduleHover(() => setActive(null))}
      >
        {children}
      </div>
    </SubmenuContext.Provider>
  );
}

/** Left-opening flyout for trailing action menus, shared by editor and session headers. */
export function ActionSubmenu({
  label,
  value,
  icon,
  disabled = false,
  dataTestId,
  children,
}: {
  label: string;
  /** Current setting, displayed before the submenu chevron. */
  value?: React.ReactNode;
  icon: React.ReactNode;
  disabled?: boolean;
  dataTestId: string;
  children: React.ReactNode;
}) {
  const id = useId();
  const context = useContext(SubmenuContext);
  if (!context) throw new Error("ActionSubmenu requires an ActionMenuSurface");
  const { active, setActive, hoverSubmenu, cancelHover, fitSubmenus } = context;
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
    const leftEdge = parent.left - panel.width - DROPDOWN_PANEL.submenuGap;
    const opensRight = fitSubmenus && leftEdge < padding;
    const preferredLeft = opensRight
      ? parent.right + DROPDOWN_PANEL.submenuGap
      : leftEdge;
    const left = Math.max(
      padding,
      fitSubmenus
        ? Math.min(preferredLeft, window.innerWidth - panel.width - padding)
        : preferredLeft
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
    flyoutRef.current.style.left = `${left - (opensRight ? DROPDOWN_PANEL.submenuGap : 0)}px`;
    flyoutRef.current.style.top = `${top}px`;
    flyoutRef.current.style.paddingRight = opensRight
      ? "0px"
      : `${DROPDOWN_PANEL.submenuGap}px`;
    flyoutRef.current.style.paddingLeft = opensRight
      ? `${DROPDOWN_PANEL.submenuGap}px`
      : "0px";
    panelRef.current.dataset.actionMenuSide = opensRight ? "right" : "left";
    if (fitSubmenus && document.activeElement === rowRef.current) {
      panelRef.current.querySelector<HTMLElement>(ACTION_SELECTOR)?.focus();
    }
  });

  return (
    <div data-action-menu-group={id}>
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
          if (!disabled) hoverSubmenu(id);
        }}
        onClick={() => setActive(id)}
        suffix={
          <span className="inline-flex items-center gap-2">
            {value}
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              size={DROPDOWN_ITEM.iconSize}
            />
          </span>
        }
      >
        {label}
      </DropdownItem>
      {open && (
        <div
          ref={flyoutRef}
          className="fixed"
          style={{ paddingRight: DROPDOWN_PANEL.submenuGap }}
          onMouseEnter={cancelHover}
        >
          <div
            ref={panelRef}
            role="menu"
            aria-label={label}
            data-action-menu-submenu="true"
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
