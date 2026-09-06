/**
 * useEventBlockHeader - Reusable hook for event block header state
 *
 * Manages collapsed state, header hover state, and optional event locate handler.
 *
 * For event replay, pass `eventId` — the hook pairs with `useBlockLocate`
 * (from the blocks barrel) which wires up simulator navigation without
 * creating a circular dependency through the SessionCore barrel.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useContext, useEffect, useState } from "react";

import { useChatCollapseState } from "@src/engines/ChatPanel/ChatCollapseScope";

import { NestedBlockContext } from "./nestedBlockContext";

export interface UseEventBlockHeaderOptions {
  /** Initial collapsed state */
  defaultCollapsed?: boolean;
  /** Callback when collapsed state changes */
  onToggle?: (isCollapsed: boolean) => void;
  /** Optional event ID — stored for handleLocate (requires useBlockLocate to wire up) */
  eventId?: string;
  /**
   * Value to set `isCollapsed` to when the global "collapse all" fires.
   * - `true`  — standard pattern (`!isCollapsed && content`)
   * - `false` — inverted pattern (`isCollapsed` renamed to `isExpanded`)
   * - `undefined` (default) — this block does not participate
   */
  collapseAllValue?: boolean;
  /**
   * When true, the global "expand all" command does not force this block
   * open. Use this for tool blocks whose default/auto-collapse behavior
   * should remain authoritative (terminal output, explore/ls results, etc.).
   */
  preserveDefaultOnExpand?: boolean;
}

export interface UseEventBlockHeaderReturn {
  /** Whether the block is collapsed */
  isCollapsed: boolean;
  /** Whether the header is hovered */
  isHeaderHovered: boolean;
  /** Toggle collapsed state */
  toggleCollapsed: () => void;
  /** Set collapsed state directly */
  setIsCollapsed: (collapsed: boolean) => void;
  /** Set header hover state */
  setIsHeaderHovered: (hovered: boolean) => void;
  /** Header mouse enter handler */
  handleHeaderMouseEnter: () => void;
  /** Header mouse leave handler */
  handleHeaderMouseLeave: () => void;
  /** Header click handler (toggles collapse) */
  handleHeaderClick: () => void;
  /** Navigate to eventId in the simulator (undefined if eventId was not provided) */
  handleLocate: (() => void) | undefined;
}

/**
 * Hook for managing event block header state
 */
export function useEventBlockHeader(
  options: UseEventBlockHeaderOptions = {}
): UseEventBlockHeaderReturn {
  const {
    defaultCollapsed = false,
    onToggle,
    eventId,
    collapseAllValue,
    preserveDefaultOnExpand = false,
  } = options;

  const { collapseAllCommandAtom, collapseStateAtom, setCollapseStateAtom } =
    useChatCollapseState();
  const isNested = useContext(NestedBlockContext);

  const collapseMap = useAtomValue(collapseStateAtom);
  const persistCollapse = useSetAtom(setCollapseStateAtom);

  const participates = collapseAllValue !== undefined;
  const command = useAtomValue(collapseAllCommandAtom);
  const collapseAllCommand = participates
    ? command
    : { epoch: 0, collapsed: false };

  // Nested (subagent sub-activity) blocks default collapsed but can be
  // expanded by clicking. The persisted collapse map is still checked so
  // a user's explicit expand survives re-renders.
  const nestedDefault = true;
  const defaultCollapsedValue = isNested ? nestedDefault : defaultCollapsed;
  const persistedCollapsed =
    eventId !== undefined ? collapseMap.get(eventId) : undefined;
  const commandCollapsed =
    participates &&
    collapseAllCommand.epoch > 0 &&
    (!preserveDefaultOnExpand || collapseAllCommand.collapsed)
      ? collapseAllCommand.collapsed === collapseAllValue
      : undefined;
  const initialCollapsed =
    persistedCollapsed ?? commandCollapsed ?? defaultCollapsedValue;

  const [isCollapsed, setIsCollapsed] = useState(initialCollapsed);
  const [isHeaderHovered, setIsHeaderHovered] = useState(false);
  // Safety net: reset hover on unmount (onMouseLeave can miss)
  useEffect(() => {
    return () => setIsHeaderHovered(false);
  }, []);

  const [prevEpoch, setPrevEpoch] = useState(collapseAllCommand.epoch);
  if (
    collapseAllValue !== undefined &&
    collapseAllCommand.epoch !== prevEpoch
  ) {
    setPrevEpoch(collapseAllCommand.epoch);
    setIsCollapsed(
      preserveDefaultOnExpand && !collapseAllCommand.collapsed
        ? defaultCollapsedValue
        : collapseAllCommand.collapsed === collapseAllValue
    );
  }

  const toggleCollapsed = useCallback(() => {
    setIsCollapsed((prev) => {
      const newValue = !prev;
      onToggle?.(newValue);
      if (eventId) {
        persistCollapse({ eventId, collapsed: newValue });
      }
      return newValue;
    });
  }, [onToggle, eventId, persistCollapse]);

  const handleHeaderMouseEnter = useCallback(() => {
    setIsHeaderHovered(true);
  }, []);

  const handleHeaderMouseLeave = useCallback(() => {
    setIsHeaderHovered(false);
  }, []);

  const handleHeaderClick = useCallback(() => {
    toggleCollapsed();
  }, [toggleCollapsed]);

  return {
    isCollapsed,
    isHeaderHovered,
    toggleCollapsed,
    setIsCollapsed,
    setIsHeaderHovered,
    handleHeaderMouseEnter,
    handleHeaderMouseLeave,
    handleHeaderClick,
    handleLocate: undefined,
  };
}

export default useEventBlockHeader;
