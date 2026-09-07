import { atom } from "jotai";

const MAX_COLLAPSE_ENTRIES = 200;
const MAX_TURN_OVERRIDE_ENTRIES = 200;

type CollapseAllCommand = {
  epoch: number;
  collapsed: boolean;
};

export function createCollapseState() {
  /**
   * Global collapse state for chat blocks.
   * Maps eventId -> collapsed (boolean) so user toggles persist
   * across scroll-out/scroll-in re-mounts.
   */
  const collapseStateAtom = atom<Map<string, boolean>>(new Map());

  const setCollapseStateAtom = atom(
    null,
    (
      get,
      set,
      { eventId, collapsed }: { eventId: string; collapsed: boolean }
    ) => {
      const current = new Map(get(collapseStateAtom));
      if (current.size >= MAX_COLLAPSE_ENTRIES && !current.has(eventId)) {
        const firstKey = current.keys().next().value;
        if (firstKey) current.delete(firstKey);
      }
      current.set(eventId, collapsed);
      set(collapseStateAtom, current);
    }
  );

  /** Global command for "collapse all" / "expand all" in chat panels. */
  const collapseAllCommandAtom = atom<CollapseAllCommand>({
    epoch: 0,
    collapsed: false,
  });

  const setAllBlocksCollapsedAtom = atom(
    null,
    (get, set, collapsed: boolean) => {
      const current = get(collapseAllCommandAtom);
      set(collapseAllCommandAtom, {
        epoch: current.epoch + 1,
        collapsed,
      });
      set(collapseStateAtom, new Map());
      set(turnCollapseOverrideAtom, new Map());
    }
  );

  // ============================================
  // Per-turn collapse state ("Worked for xxx" summary)
  // ============================================

  /**
   * Per-turn collapse override map keyed by `turnId` (the user-message event
   * id at the head of a chat group). Completed turns are collapsed by default;
   * this map only records explicit user overrides via the pin-bar chevron.
   *
   *   undefined  -> default behaviour (completed = collapsed, active = expanded)
   *   true       -> user forced this turn collapsed
   *   false      -> user forced this turn expanded
   */
  const turnCollapseOverrideAtom = atom<Map<string, boolean>>(new Map());

  const setTurnCollapseOverrideAtom = atom(
    null,
    (
      get,
      set,
      { turnId, collapsed }: { turnId: string; collapsed: boolean | undefined }
    ) => {
      const current = new Map(get(turnCollapseOverrideAtom));
      if (collapsed === undefined) {
        current.delete(turnId);
      } else {
        if (current.size >= MAX_TURN_OVERRIDE_ENTRIES && !current.has(turnId)) {
          const firstKey = current.keys().next().value;
          if (firstKey) current.delete(firstKey);
        }
        current.set(turnId, collapsed);
      }
      set(turnCollapseOverrideAtom, current);
    }
  );

  return {
    collapseStateAtom,
    setCollapseStateAtom,
    collapseAllCommandAtom,
    setAllBlocksCollapsedAtom,
    turnCollapseOverrideAtom,
    setTurnCollapseOverrideAtom,
  };
}

export const {
  collapseStateAtom,
  setCollapseStateAtom,
  collapseAllCommandAtom,
  setAllBlocksCollapsedAtom,
  turnCollapseOverrideAtom,
  setTurnCollapseOverrideAtom,
} = createCollapseState();
