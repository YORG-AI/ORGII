import { useCallback, useState } from "react";

export type ComposerMenuKind = "context" | "slash";

export function resolveComposerMenuVisibility(
  current: ComposerMenuKind | null,
  menu: ComposerMenuKind,
  visible: boolean
): ComposerMenuKind | null {
  if (visible) return menu;
  return current === menu ? null : current;
}

/** One source of truth for the mutually-exclusive inline composer menus. */
export function useExclusiveComposerMenuState() {
  const [activeMenu, setActiveMenu] = useState<ComposerMenuKind | null>(null);

  const setShowContextMenu = useCallback((visible: boolean) => {
    setActiveMenu((current) =>
      resolveComposerMenuVisibility(current, "context", visible)
    );
  }, []);
  const setShowSlashMenu = useCallback((visible: boolean) => {
    setActiveMenu((current) =>
      resolveComposerMenuVisibility(current, "slash", visible)
    );
  }, []);

  return {
    showContextMenu: activeMenu === "context",
    setShowContextMenu,
    showSlashMenu: activeMenu === "slash",
    setShowSlashMenu,
  };
}
