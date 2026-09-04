import { useAtomValue } from "jotai";

import { sidebarCollapsedAtom } from "@src/store/ui/sidebarAtom";

export type PathTreePosition = "left" | "right";

/** Match every composer path preview to the global sidebar visibility. */
export function resolvePathTreePosition(
  sidebarCollapsed: boolean
): PathTreePosition {
  return sidebarCollapsed ? "right" : "left";
}

/** Shared direction for `/` skill paths and `@` file paths. */
export function usePathTreePosition(): PathTreePosition {
  return resolvePathTreePosition(useAtomValue(sidebarCollapsedAtom));
}
