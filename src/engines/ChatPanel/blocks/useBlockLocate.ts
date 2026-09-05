/**
 * useBlockLocate - Thin wrapper that combines useEventBlockHeader with event replay.
 *
 * This hook lives outside of primitives/ to avoid a circular dependency:
 *   primitives → useChatEventReplay → SessionCore barrel → primitives
 *
 * Blocks should use this instead of manually wiring useChatEventReplay.
 *
 * Usage:
 *   const { isCollapsed, handleLocate, ... } = useBlockHeader({ defaultCollapsed, eventId });
 */
import { useCallback } from "react";

import { useChatEventReplay } from "@src/engines/ChatPanel/hooks/useChatEventReplay";

import {
  type UseEventBlockHeaderOptions,
  type UseEventBlockHeaderReturn,
  useEventBlockHeader,
} from "./primitives/useEventBlockHeader";

/**
 * Extended header hook that adds event-replay locate support.
 * Drop-in replacement for `useEventBlockHeader` when `eventId` is needed.
 */
export function useBlockHeader(
  options: UseEventBlockHeaderOptions = {}
): UseEventBlockHeaderReturn {
  const { eventId, ...rest } = options;
  const headerState = useEventBlockHeader(rest);

  const { replayEventById } = useChatEventReplay();

  const handleLocate = useCallback(() => {
    if (eventId) {
      replayEventById(eventId);
    }
  }, [eventId, replayEventById]);

  return {
    ...headerState,
    handleLocate: eventId ? handleLocate : undefined,
  };
}
