/**
 * useTauriSelectAllShortcut Hook
 *
 * Tauri's WKWebView (macOS) intercepts ⌘A at the native layer **before**
 * the browser's built-in `select-all` behavior fires inside a focused
 * <input> / <textarea>. The net effect is that pressing ⌘A in any plain
 * text control does nothing — the user has to manually drag-select.
 *
 * This hook is the single source of truth for the workaround: it listens
 * for ⌘A / Ctrl+A in the focused control's own `onKeyDown` and calls
 * `target.select()` manually. Spread the returned handler onto any
 * `<input type="text">` / `<textarea>`-style element where ⌘A should
 * select-all:
 *
 * ```tsx
 * const tauriSelectAll = useTauriSelectAllShortcut();
 *
 * <input
 *   onKeyDown={(event) => {
 *     tauriSelectAll(event);
 *     // …caller's other key handling, only runs if ⌘A wasn't matched
 *   }}
 * />
 * ```
 *
 * Or, when the caller doesn't need its own keydown, pass the handler
 * directly:
 *
 * ```tsx
 * <input onKeyDown={tauriSelectAll} />
 * ```
 *
 * The handler is a no-op when the event's `defaultPrevented` is already
 * true (i.e. a higher-priority handler claimed the key) or when the
 * event target isn't an editable element.
 *
 * Scope:
 *   - Pointer-driven multi-cell selection (e.g. `VirtualTableGrid`'s
 *     "select every cell on ⌘A") is a different semantic and must NOT
 *     use this hook — it owns its own ⌘A handling.
 */
import { useCallback } from "react";

type EditableElement = HTMLInputElement | HTMLTextAreaElement;

/**
 * Minimal event shape we depend on. Accepting this lets the same handler
 * be used with React's `KeyboardEvent<HTMLInputElement>`,
 * `KeyboardEvent<HTMLTextAreaElement>`, generic
 * `KeyboardEvent<Element>`, AND native DOM `KeyboardEvent`s
 * without forcing callers to cast.
 */
type SelectAllEventLike = {
  defaultPrevented: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  key: string;
  target: EventTarget | null;
  preventDefault: () => void;
  stopPropagation: () => void;
};

function isEditableElement(
  target: EventTarget | null
): target is EditableElement {
  return (
    target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement
  );
}

function getEditableTarget(
  target: EventTarget | null | undefined
): EditableElement | null {
  const normalizedTarget = target ?? null;
  return isEditableElement(normalizedTarget) ? normalizedTarget : null;
}

/**
 * Returns a stable keydown handler that implements ⌘A / Ctrl+A
 * "select all text in the focused control" for Tauri webviews.
 *
 * Safe to spread into any `<input>` or `<textarea>` `onKeyDown`. Also
 * accepts native DOM `KeyboardEvent`s so it can be reused inside
 * `document.addEventListener("keydown", …)` callbacks.
 */
export function useTauriSelectAllShortcut(): (
  event: SelectAllEventLike
) => void {
  return useCallback((event: SelectAllEventLike) => {
    handleSelectAllEvent(event);
  }, []);
}

export function handleSelectAllEvent(event: SelectAllEventLike): void {
  if (event.defaultPrevented) return;
  if (!(event.metaKey || event.ctrlKey)) return;
  if (event.shiftKey || event.altKey) return;
  if (event.key.toLowerCase() !== "a") return;

  const target =
    getEditableTarget(event.target) ??
    getEditableTarget(
      typeof document === "undefined" ? null : document.activeElement
    );
  if (!target) return;

  try {
    target.select();
  } catch {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
}

/**
 * App-level fallback. Installs ONE capture-phase `keydown` listener on the
 * document so every focused `<input>` / `<textarea>` in the app gets ⌘A
 * select-all behavior even if the surrounding component never wired the
 * `useTauriSelectAllShortcut` hook into its own `onKeyDown`.
 *
 * Idempotent: safe to call multiple times; subsequent calls are no-ops.
 *
 * Call once during app bootstrap (see `src/index.tsx`).
 */
let globalInstalled = false;

export function installGlobalTauriSelectAllShortcut(): void {
  if (globalInstalled) return;
  if (typeof document === "undefined") return;
  globalInstalled = true;

  document.addEventListener(
    "keydown",
    (event) => {
      handleSelectAllEvent(event);
    },
    // Capture phase so this fallback can run before parent capture shortcuts.
    // It only claims Ctrl/Cmd+A for native text controls, so editors such as
    // CodeMirror and xterm keep their own selection behavior.
    true
  );
}

export default useTauriSelectAllShortcut;
