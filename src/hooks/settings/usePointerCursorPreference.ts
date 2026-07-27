import { useEffect } from "react";

import { useSettingValue } from "./useSettings";

export const POINTER_CURSORS_ATTRIBUTE = "data-pointer-cursors";

type AttributeTarget = Pick<HTMLElement, "removeAttribute" | "setAttribute">;

export function applyPointerCursorPreference(
  target: AttributeTarget,
  enabled: boolean
): () => void {
  target.setAttribute(POINTER_CURSORS_ATTRIBUTE, String(enabled));

  return () => {
    target.removeAttribute(POINTER_CURSORS_ATTRIBUTE);
  };
}

/**
 * Applies the pointer-cursor preference to the document root.
 *
 * The matching global CSS only supplies a default for semantic interactive
 * controls. More specific cursors such as text, resize, grab, wait, and
 * not-allowed continue to win.
 */
export function usePointerCursorPreference(): void {
  const usePointerCursors = useSettingValue("general.usePointerCursors");

  useEffect(
    () =>
      applyPointerCursorPreference(document.documentElement, usePointerCursors),
    [usePointerCursors]
  );
}
