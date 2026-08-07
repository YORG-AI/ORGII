/**
 * useDropdownAutoKeyboard Hook
 *
 * Zero-config keyboard navigation fallback for dropdowns that don't pass
 * an explicit `listNavigation` config to `useDropdownEngine`.
 *
 * Strategy:
 *   - While the dropdown is open, discover focusable rows inside
 *     `panelRef.current` by DOM query (buttons / `[role="menuitem"]` /
 *     `[role="option"]` that are not `[disabled]` and not opted-out via
 *     `[data-dropdown-keyboard-skip="true"]`).
 *   - Track a highlighted row index in state. Apply the highlight by
 *     setting `data-dropdown-keyboard-highlight="true"` on the active
 *     DOM node (CSS in `src/index.scss` paints it with the same
 *     `--color-fill-2` background as :hover).
 *   - Capture document-level keydown while open: ArrowUp/Down/Home/End
 *     move the highlight, Enter dispatches a synthetic click on the
 *     highlighted node, Escape closes the dropdown.
 *     `useDropdownEngine` also installs a bubble-phase Escape handler;
 *     our capture-phase `stopPropagation` keeps it from running twice.
 *   - Start with no highlight on open (matches native macOS menu / Cursor
 *     palette behaviour: a click-to-open + hover-and-click flow doesn't
 *     surprise the user with a pre-highlighted row; the first ArrowDown
 *     promotes the first selectable row). Clear the highlight when the
 *     mouse moves over the panel so pointer + keyboard don't fight.
 *
 * Constraints:
 *   - Must NOT activate when the caller passes `listNavigation` to the
 *     engine (the explicit path takes over) or when `autoKeyboardNavigation`
 *     is disabled (e.g. `Select`, which already runs its own
 *     `useDropdownKeyboard` against a typed option list).
 *   - Must not steal text-editing keys from editable elements in the
 *     panel. The handler bails when the event target is editable AND the
 *     key would have a meaningful editing effect:
 *       - `<textarea>` / `contentEditable`: bail on every key.
 *       - `<input>` (single-line): bail on every key EXCEPT ArrowUp /
 *         ArrowDown / Enter, which have no caret-movement effect there
 *         and are forwarded to the highlight/commit logic. This is what
 *         lets a "search input + action rows" panel (e.g.
 *         `TabBarPlusMenu`) be driven entirely from the keyboard.
 *       - Escape inside an editable element is left to the host
 *         component (typical contract: the input clears itself / closes
 *         the panel via its own `onKeyDown`).
 */
import { type RefObject, useCallback, useEffect, useRef } from "react";

// ============================================
// Types
// ============================================

export interface UseDropdownAutoKeyboardOptions {
  /** Whether the dropdown is currently open. */
  isOpen: boolean;
  /** Panel ref - the hook queries rows from this subtree. */
  panelRef: RefObject<HTMLElement | null>;
  /** Close the dropdown (used after a row is committed via Enter). */
  onClose: () => void;
  /** When `false`, the hook is a no-op. */
  enabled: boolean;
}

// ============================================
// Constants
// ============================================

/**
 * Selector for rows that participate in keyboard navigation.
 *
 * `button:not([disabled])` covers every dropdown built with `<button>`
 * rows (the vast majority). `[role="menuitem"]` / `[role="option"]`
 * cover the rare div-based rows. Anything that should explicitly be
 * skipped (separators, section headers wrapped in a clickable element)
 * can opt out via `data-dropdown-keyboard-skip="true"`.
 */
const ROW_SELECTOR = [
  'button:not([disabled]):not([data-dropdown-keyboard-skip="true"])',
  '[role="menuitem"]:not([aria-disabled="true"]):not([data-dropdown-keyboard-skip="true"])',
  '[role="option"]:not([aria-disabled="true"]):not([data-dropdown-keyboard-skip="true"])',
].join(", ");

const HIGHLIGHT_ATTR = "data-dropdown-keyboard-highlight";
const KEYBOARD_MODE_ATTR = "data-dropdown-keyboard-mode";

// ============================================
// Helpers
// ============================================

function queryRows(panel: HTMLElement | null): HTMLElement[] {
  if (!panel) return [];
  // Exclude rows nested inside a sub-popover/portal that happens to be
  // a descendant of the panel (rare). We rely on the panel author to
  // keep nested controls outside the panel subtree, which is the
  // current convention.
  return Array.from(panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)).filter(
    (element) => {
      // Skip rows whose ancestor is collapsed/hidden.
      if (element.offsetParent === null && element.tagName !== "BUTTON") {
        return false;
      }
      return true;
    }
  );
}

/**
 * Returns true when the event target is an editable element AND the
 * pressed key would have a meaningful editing effect on it.
 *
 * Single-line `<input>` elements ignore ArrowUp/ArrowDown, so those keys
 * are allowed through to drive the dropdown highlight even when focus is
 * inside the panel's search input. Home/End are kept "bail" inside inputs
 * because they move the caret, which the user expects to keep working.
 * Multi-line targets (`<textarea>`, `contentEditable`) bail unconditionally
 * so caret movement isn't hijacked.
 *
 * Enter is always allowed through; the hook's own handler only commits a
 * row when one is highlighted, otherwise the editable element's native
 * Enter handler (e.g. search submit) keeps working.
 */
function shouldBailForEditableTarget(
  target: EventTarget | null,
  key: string
): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "SELECT") return true;
  if (tag === "TEXTAREA") return true;
  if (target.isContentEditable) return true;
  if (tag === "INPUT") {
    return key !== "ArrowUp" && key !== "ArrowDown" && key !== "Enter";
  }
  return false;
}

function clearHighlight(panel: HTMLElement | null): void {
  if (!panel) return;
  const previous = panel.querySelectorAll<HTMLElement>(`[${HIGHLIGHT_ATTR}]`);
  previous.forEach((element) => {
    element.removeAttribute(HIGHLIGHT_ATTR);
  });
}

function setKeyboardMode(panel: HTMLElement | null, enabled: boolean): void {
  if (!panel) return;
  if (enabled) {
    panel.setAttribute(KEYBOARD_MODE_ATTR, "true");
  } else {
    panel.removeAttribute(KEYBOARD_MODE_ATTR);
  }
}

function applyHighlight(row: HTMLElement | null, panel: HTMLElement | null) {
  clearHighlight(panel);
  if (!row) return;
  setKeyboardMode(panel, true);
  row.setAttribute(HIGHLIGHT_ATTR, "true");
  row.scrollIntoView({ block: "nearest" });
}

// ============================================
// Hook
// ============================================

export function useDropdownAutoKeyboard({
  isOpen,
  panelRef,
  onClose,
  enabled,
}: UseDropdownAutoKeyboardOptions): void {
  const indexRef = useRef<number>(-1);

  // Reset highlight on every (re-)open. We deliberately leave the
  // highlight UNSET so a click-to-open + mouse-hover-then-click flow
  // doesn't surprise users with a pre-highlighted row. The first
  // ArrowDown promotes the first selectable row to highlighted; this
  // matches native macOS menu / Cursor command palette behaviour.
  useEffect(() => {
    if (!enabled) return;
    if (!isOpen) {
      indexRef.current = -1;
      return;
    }
    const panel = panelRef.current;
    return () => {
      clearHighlight(panel);
      setKeyboardMode(panel, false);
      indexRef.current = -1;
    };
  }, [isOpen, enabled, panelRef]);

  // Clear highlight when the user moves the mouse inside the panel so
  // pointer hover takes over without competing visuals. We require a real
  // change in cursor coordinates: a click-to-open leaves the pointer over
  // the freshly-mounted panel, and the browser fires a `mousemove` when an
  // element appears under a stationary cursor (or on sub-pixel tremor).
  // Treating that phantom event as "the user moved the mouse" would reset
  // the keyboard highlight and make the first Arrow key press appear to do
  // nothing (it takes a second press to re-establish the highlight).
  useEffect(() => {
    if (!enabled || !isOpen) return;
    const panel = panelRef.current;
    if (!panel) return;

    let lastX: number | null = null;
    let lastY: number | null = null;

    const handleMouseMove = (event: MouseEvent) => {
      if (lastX === event.clientX && lastY === event.clientY) return;
      const isFirstEvent = lastX === null && lastY === null;
      lastX = event.clientX;
      lastY = event.clientY;
      // Ignore the initial phantom mousemove emitted when the panel mounts
      // under a stationary cursor; only real motion should hand control back
      // to the pointer.
      if (isFirstEvent) return;
      if (indexRef.current === -1) return;
      indexRef.current = -1;
      clearHighlight(panel);
      setKeyboardMode(panel, false);
    };

    panel.addEventListener("mousemove", handleMouseMove);
    return () => {
      panel.removeEventListener("mousemove", handleMouseMove);
    };
  }, [enabled, isOpen, panelRef]);

  const move = useCallback(
    (delta: 1 | -1 | "first" | "last") => {
      const panel = panelRef.current;
      const rows = queryRows(panel);
      if (rows.length === 0) {
        indexRef.current = -1;
        setKeyboardMode(panel, false);
        return;
      }
      const current = indexRef.current;
      let next: number;
      if (delta === "first") next = 0;
      else if (delta === "last") next = rows.length - 1;
      else if (current === -1) {
        next = delta === 1 ? 0 : rows.length - 1;
      } else {
        next = current + delta;
        if (next < 0) next = 0;
        if (next > rows.length - 1) next = rows.length - 1;
      }
      indexRef.current = next;
      applyHighlight(rows[next] ?? null, panel);
    },
    [panelRef]
  );

  const commit = useCallback(() => {
    const panel = panelRef.current;
    const rows = queryRows(panel);
    const current = indexRef.current;
    if (current < 0 || current >= rows.length) return false;
    const row = rows[current];
    // Use the native click so React onClick handlers fire identically
    // to a real pointer click.
    row.click();
    return true;
  }, [panelRef]);

  // Document-level capture listener — mirrors the strategy in
  // `useDropdownListNavigation` so keys are caught regardless of where
  // focus currently lives (trigger button, document.body, …).
  useEffect(() => {
    if (!enabled || !isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      // Don't hijack typing inside an editable element nested in the
      // panel. Single-line `<input>` lets ArrowUp/ArrowDown/Enter through
      // so a search-with-actions layout (e.g. `TabBarPlusMenu`) can be
      // driven entirely from the keyboard without manual wiring.
      if (shouldBailForEditableTarget(event.target, event.key)) return;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          event.stopPropagation();
          move(1);
          return;
        case "ArrowUp":
          event.preventDefault();
          event.stopPropagation();
          move(-1);
          return;
        case "Home":
          event.preventDefault();
          event.stopPropagation();
          move("first");
          return;
        case "End":
          event.preventDefault();
          event.stopPropagation();
          move("last");
          return;
        case "Enter": {
          // Only commit when a row is highlighted. Otherwise let the
          // event reach whatever has focus (e.g. the trigger or a search
          // input with its own submit handler), so pressing Enter on an
          // unopened dropdown or in an empty search box doesn't silently
          // do nothing.
          if (indexRef.current < 0) return;
          event.preventDefault();
          event.stopPropagation();
          const committed = commit();
          if (committed) onClose();
          return;
        }
        case "Escape": {
          // `useDropdownEngine` runs its own Escape handler, so in that
          // path this branch is a redundant close (the panel is already
          // about to unmount). For consumers wiring this hook directly
          // (e.g. the legacy `Dropdown` component in droplist mode) this
          // is the only Escape handler, so closing here is required for
          // keyboard parity with the engine path.
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [enabled, isOpen, move, commit, onClose]);
}

export default useDropdownAutoKeyboard;
