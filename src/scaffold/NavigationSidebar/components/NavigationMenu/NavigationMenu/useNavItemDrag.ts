import { useCallback, useLayoutEffect, useRef } from "react";

import {
  type ReferencePillDragState,
  useReferencePillDrag,
} from "@src/shared/dnd/useReferencePillDrag";

import type { NavigationMenuItem } from "../config";

export type NavItemDragState = ReferencePillDragState;

export function useNavItemDrag(item: NavigationMenuItem): {
  dragHandlers: React.HTMLAttributes<HTMLElement>;
  dragState: NavItemDragState | null;
} {
  const itemRef = useRef(item);
  useLayoutEffect(() => {
    itemRef.current = item;
  });

  const getPayload = useCallback(() => itemRef.current.dragPayload, []);

  return useReferencePillDrag<HTMLElement>({
    enabled: Boolean(item.dragPayload),
    tabId: item.id,
    getPayload,
  });
}
