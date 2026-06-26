/**
 * useChatGroups Hook
 *
 * Splits the flat optimizedChatHistory into groups for the chat list.
 * Each user message starts a new group and becomes its group header.
 * Programmatic interrupts such as Force Send can produce adjacent user
 * messages without an intervening assistant event; they are still distinct
 * turns and must not collapse into one round.
 * Items before the first user message form a header-less preamble group.
 *
 * When `collapseOverrides` / `isAgentWorking` are provided, the hook also
 * APPLIES the shared "Agent worked for …" collapse at the group
 * level: collapsed turns drop all but their last assistant message from
 * `flatItems` and `groupCounts`. This is required for virtualization to
 * recompute total list height correctly — hiding items inline (via
 * `return null` from the item renderer) leaves measured size caches
 * pointing at the pre-collapse heights, which manifested as a large
 * blank tail beneath the surviving last reply. By making collapse a
 * structural transform here, the virtualization layer only ever sees
 * real, rendered items.
 *
 * Returns:
 * - groupCounts       — item count per group (excluding the header)
 * - groupHeaders      — the user OptimizedChatItem for each group (null for preamble)
 * - flatItems         — all non-header items in order, post-collapse
 * - totalFlatItems    — flatItems.length (convenience)
 * - originalToFlatIndex — maps an optimizedChatHistory index to a
 *     virtual flat-item index (for search scrollToIndex).
 *     User-message indices map to the first surviving item of that group;
 *     items dropped by collapse map to the surviving last-assistant flat
 *     index of their turn so search still lands on the right turn.
 */
import { useMemo } from "react";

import { isAgentErrorEvent } from "../chatItemPipeline/classifiers";
import { isAssistantMessageEvent } from "../chatItemPipeline/dedup";
import type { OptimizedChatItem } from "../chatItemPipeline/types";

export interface UnloadedTurnMeta {
  turnId: string;
  nextTurnId?: string | null;
  startedAt?: string;
  endedAt?: string;
  eventCount?: number;
  bodyEventCount?: number;
  durationMs?: number;
}

function getObjectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function getUnloadedTurnMeta(
  item: OptimizedChatItem | undefined
): UnloadedTurnMeta | null {
  const result = item?.event?.result;
  const shared = getObjectRecord(result?.unloadedTurn);
  if (shared) {
    const turnId = shared.turnId;
    if (typeof turnId === "string" && turnId.length > 0) {
      const nextTurnId = shared.nextTurnId;
      const startedAt = shared.startedAt;
      const endedAt = shared.endedAt;
      const eventCount = shared.eventCount;
      const bodyEventCount = shared.bodyEventCount;
      const durationMs = shared.durationMs;
      return {
        turnId,
        nextTurnId: typeof nextTurnId === "string" ? nextTurnId : null,
        startedAt: typeof startedAt === "string" ? startedAt : undefined,
        endedAt: typeof endedAt === "string" ? endedAt : undefined,
        eventCount: typeof eventCount === "number" ? eventCount : undefined,
        bodyEventCount:
          typeof bodyEventCount === "number" ? bodyEventCount : undefined,
        durationMs: typeof durationMs === "number" ? durationMs : undefined,
      };
    }
  }

  return null;
}

function isUnloadedTurnItem(item: OptimizedChatItem | undefined): boolean {
  return getUnloadedTurnMeta(item) !== null;
}

function withoutUnloadedTurnItems(
  items: OptimizedChatItem[]
): OptimizedChatItem[] {
  return items.filter((item) => !isUnloadedTurnItem(item));
}

function isUserMessageItem(item: OptimizedChatItem | undefined): boolean {
  return item?.event?.source === "user" && Boolean(item.event.displayText);
}

/**
 * The collapse-survivor predicate. Mirrors `useLastAssistantIndexByGroup`'s
 * definition of "final reply" — only completed assistant-message events
 * qualify, so a streaming/failed tail message is never silently elevated
 * to "the surviving last reply" of a collapsed turn.
 */
function isCompletedAssistantMessage(item: OptimizedChatItem): boolean {
  if (isUnloadedTurnItem(item)) return false;
  const event = item.event;
  if (!event) return false;
  if (event.displayStatus !== "completed") return false;
  return isAssistantMessageEvent(event);
}

/**
 * Terminal error card predicate. Delegates to the shared
 * `isAgentErrorEvent` chokepoint (chatItemPipeline/classifiers.ts) so the
 * collapse layer and ActivityRouter can never drift on what counts as an
 * error. These must survive the turn collapse — otherwise a failed turn
 * collapses down to its last successful narration line and the error is
 * invisible (the "quota error shows as blank space" bug, 2026-06-10).
 */
function isAgentErrorItem(item: OptimizedChatItem): boolean {
  if (isUnloadedTurnItem(item)) return false;
  const event = item.event;
  if (!event) return false;
  return isAgentErrorEvent(event);
}

interface ChatGroup {
  header: OptimizedChatItem | null;
  items: OptimizedChatItem[];
}

/**
 * Per-group metadata used by the turn collapse pin-bar.
 *
 * `turnId` is the user-message event id (stable across re-renders) and
 * doubles as the override key in `turnCollapseOverrideAtom`. `durationMs`
 * spans the user message → last group item; it's the "Worked for xxx"
 * value rendered in the pin-bar. Headerless preamble groups have
 * `turnId === null` and never get a collapse bar.
 */
export interface ChatGroupMeta {
  turnId: string | null;
  durationMs: number;
  itemCount: number;
  previewText: string;
  /**
   * Epoch ms of the user-message kicking off the turn (`null` for the
   * headerless preamble or when `createdAt` is unparseable). Used by the
   * collapse pin-bar to render a `HH:MM → HH:MM` time range subtitle.
   */
  startMs: number | null;
  /**
   * Epoch ms of the last item in the group (`null` when the group has no
   * body items yet, or when no item carries a parseable timestamp). Pairs
   * with `startMs` for the pin-bar subtitle.
   */
  endMs: number | null;
  unloadedTurn: UnloadedTurnMeta | null;
}

export interface UseChatGroupsReturn {
  groupCounts: number[];
  groupHeaders: (OptimizedChatItem | null)[];
  /** Per-group metadata indexed the same way as `groupCounts`. */
  groupMeta: ChatGroupMeta[];
  flatItems: OptimizedChatItem[];
  totalFlatItems: number;
  originalToFlatIndex: Map<number, number>;
  /** Flat index of the first non-header item of the last group.
   *  `null` when the last group has no body items yet (e.g. a user message
   *  just sent with no reply). Consumers that need "from the top of the
   *  latest user message onward" should fall back to 0 in that case. */
  lastGroupFirstFlatIndex: number | null;
  /**
   * For every surviving flat item, the index of the last *surviving*
   * assistant-source item within its group, or `null` if the group has
   * no assistant body item. Pre-computed here so renderers don't need to
   * re-scan flat items by group on every render. Aligned 1-to-1 with
   * `flatItems` (each entry corresponds to the item at the same flat
   * index, NOT to a group index).
   */
  lastAssistantFlatIndexPerItem: (number | null)[];
}

/**
 * Options that gate the shared turn collapse at the group level.
 * When omitted, no collapse is applied and the hook behaves like a pure
 * grouping pass.
 */
export interface UseChatGroupsOptions {
  /**
   * Per-turn explicit collapse overrides. Map key is `turnId` (the
   * user-message event id); value is `true` for "collapsed", `false`
   * for "expanded". When a turn is not present the default (collapsed
   * for collapse-eligible turns) applies.
   */
  collapseOverrides?: ReadonlyMap<string, boolean>;
  /**
   * True while the agent is actively streaming the tail turn. Disables
   * tail regenerate affordances until the response is complete.
   */
  isAgentWorking?: boolean;
  /** Enables collapse for the latest turn after the session has been idle. */
  collapseTailWhenIdle?: boolean;
  /**
   * Force-collapse every turn with more than one body item, regardless of
   * tail / streaming / item-count gating. Used by read-only subagent
   * panes which want a tight overview by default; the user can still
   * expand individual turns via the in-history collapse pin-bar.
   */
  forceCollapseAllTurns?: boolean;
  /** Disable the structural "Agent worked for …" turn collapse entirely. */
  disableTurnCollapse?: boolean;
  allTurnsCollapsed?: boolean;
  /** Default collapse state for eligible turns when no override/bulk command applies. */
  defaultTurnCollapsed?: boolean;
  /**
   * Optional predicate for which items open a new turn group. Defaults
   * to `source === "user"` with display text. Group chat passes a
   * coordinator-human-only predicate so subagent inbox prompts stay
   * inside the current round.
   */
  isTurnHeaderItem?: (item: OptimizedChatItem) => boolean;
  isTurnBoundaryItem?: (item: OptimizedChatItem) => boolean;
}

export function useChatGroups(
  optimizedChatHistory: OptimizedChatItem[],
  options: UseChatGroupsOptions = {}
): UseChatGroupsReturn {
  const {
    collapseOverrides,
    isAgentWorking = false,
    collapseTailWhenIdle = false,
    forceCollapseAllTurns = false,
    disableTurnCollapse = false,
    allTurnsCollapsed,
    defaultTurnCollapsed = false,
    isTurnHeaderItem,
    isTurnBoundaryItem,
  } = options;
  return useMemo(() => {
    const groups: ChatGroup[] = [];
    let current: ChatGroup = { header: null, items: [] };
    const matchesTurnHeader =
      isTurnHeaderItem ??
      ((item: OptimizedChatItem) => isUserMessageItem(item));

    for (const item of optimizedChatHistory) {
      if (matchesTurnHeader(item)) {
        if (current.header || current.items.length > 0) {
          groups.push(current);
        }
        current = { header: item, items: [] };
      } else if (isTurnBoundaryItem?.(item)) {
        if (current.header || current.items.length > 0) {
          groups.push(current);
        }
        current = { header: item, items: [] };
      } else {
        current.items.push(item);
      }
    }
    if (current.header || current.items.length > 0) {
      groups.push(current);
    }

    const groupHeaders = groups.map((g) => g.header);
    // groupMeta uses the *pre-collapse* item count so the collapse-eligibility
    // check operates on the real conversation shape (an empty turn or
    // single-item turn was never going to collapse anyway).
    const groupMeta: ChatGroupMeta[] = groups.map((g) => {
      const headerEvent = g.header?.event;
      const turnId = headerEvent?.id ?? null;
      const startMs = parseEpochMs(headerEvent?.createdAt);
      const previewText = headerEvent?.displayText ?? "";

      let endMs: number | null = null;
      for (let i = g.items.length - 1; i >= 0; i--) {
        const itemEvent = g.items[i].event;
        const ms = parseEpochMs(itemEvent?.createdAt);
        if (ms !== null) {
          endMs = ms;
          break;
        }
      }

      const durationMs =
        startMs !== null && endMs !== null && endMs > startMs
          ? endMs - startMs
          : 0;

      const unloadedTurnPlaceholder =
        g.items.map(getUnloadedTurnMeta).find((value) => value !== null) ??
        null;
      const hasLoadedBodyItem = g.items.some(
        (item) => !isUnloadedTurnItem(item)
      );
      const unloadedTurn = hasLoadedBodyItem ? null : unloadedTurnPlaceholder;
      const unloadedStartMs = parseEpochMs(unloadedTurn?.startedAt);
      const unloadedEndMs = parseEpochMs(unloadedTurn?.endedAt);

      return {
        turnId,
        durationMs: unloadedTurn?.durationMs ?? durationMs,
        itemCount: g.items.length,
        previewText,
        startMs: unloadedStartMs ?? startMs,
        endMs: unloadedEndMs ?? endMs,
        unloadedTurn,
      };
    });

    // Apply per-group collapse: a collapsed turn keeps only its final
    // assistant-source body item. This is the *structural* transform —
    // it has to happen before flatItems / groupCounts are computed so
    // the virtualization layer sees the post-collapse layout.
    const groupCounts: number[] = new Array(groups.length);
    const survivingPerGroup: OptimizedChatItem[][] = new Array(groups.length);
    // For each pre-collapse item, the flat index that should be used when
    // mapping `originalToFlatIndex`. Dropped items reuse the flat index of
    // the surviving last-assistant of their group; surviving items use
    // their own flat index. Stored as `pre-index → flat-index` per group,
    // indexed by `groupIndex` then by position within the original group.
    const droppedItemTargetByGroup: (number | null)[][] = new Array(
      groups.length
    );

    let runningFlatIdx = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const meta = groupMeta[gi];
      const turnId = meta.turnId;
      const eligible =
        !disableTurnCollapse &&
        isTurnCollapseEligible(meta, gi, groups.length, {
          collapseTailWhenIdle,
          forceCollapseAllTurns,
        });
      const override =
        turnId && collapseOverrides ? collapseOverrides.get(turnId) : undefined;
      const isCollapsed =
        eligible && (override ?? allTurnsCollapsed ?? defaultTurnCollapsed);

      if (!isCollapsed) {
        const keepStructuralPlaceholder = meta.unloadedTurn !== null;
        const surviving = keepStructuralPlaceholder
          ? group.items
          : withoutUnloadedTurnItems(group.items);
        survivingPerGroup[gi] = surviving;
        droppedItemTargetByGroup[gi] = group.items.map((item) =>
          !keepStructuralPlaceholder && isUnloadedTurnItem(item)
            ? runningFlatIdx
            : null
        );
        groupCounts[gi] = surviving.length;
        runningFlatIdx += surviving.length;
        continue;
      }

      if (meta.unloadedTurn) {
        survivingPerGroup[gi] = group.items;
        droppedItemTargetByGroup[gi] = group.items.map(() => null);
        groupCounts[gi] = group.items.length;
        runningFlatIdx += group.items.length;
        continue;
      }

      // Find the index of the last completed assistant message to keep.
      // Uses the same predicate the renderer would have used to surface
      // the regenerate action, so the collapsed view always shows the
      // exact same "final reply" as the expanded view's bottom item.
      let keepIdx = -1;
      for (let i = group.items.length - 1; i >= 0; i--) {
        if (isCompletedAssistantMessage(group.items[i])) {
          keepIdx = i;
          break;
        }
      }
      // Terminal error cards (quota/rate-limit/stream-exhausted) must stay
      // visible in the collapsed view — they are the turn's actual outcome.
      // Keep every error item at/after the kept reply (or all of them when
      // the turn produced no completed reply at all).
      const errorIdxs: number[] = [];
      for (let i = Math.max(keepIdx + 1, 0); i < group.items.length; i++) {
        if (isAgentErrorItem(group.items[i])) {
          errorIdxs.push(i);
        }
      }
      if (keepIdx === -1 && errorIdxs.length > 0) {
        const keptIdxSet = new Set(errorIdxs);
        const kept = errorIdxs.map((idx) => group.items[idx]);
        survivingPerGroup[gi] = kept;
        groupCounts[gi] = kept.length;
        const firstKeptFlatIdx = runningFlatIdx;
        droppedItemTargetByGroup[gi] = group.items.map((_, idx) =>
          keptIdxSet.has(idx) ? null : firstKeptFlatIdx
        );
        runningFlatIdx += kept.length;
        continue;
      }
      if (keepIdx === -1) {
        const structuralSourceIndex = group.items.findIndex(
          (item) => !isUnloadedTurnItem(item)
        );
        const structuralSource = group.items[structuralSourceIndex];
        if (!structuralSource) {
          survivingPerGroup[gi] = [];
          droppedItemTargetByGroup[gi] = group.items.map(() => runningFlatIdx);
          groupCounts[gi] = 0;
          continue;
        }
        const keptFlatIdx = runningFlatIdx;
        survivingPerGroup[gi] = [
          {
            ...structuralSource,
            structuralOnly: true,
          },
        ];
        droppedItemTargetByGroup[gi] = group.items.map((_, idx) =>
          idx === structuralSourceIndex ? null : keptFlatIdx
        );
        groupCounts[gi] = 1;
        runningFlatIdx += 1;
        continue;
      }

      // Keep the final reply plus any terminal error cards after it.
      const keptIdxList = [keepIdx, ...errorIdxs];
      const keptIdxSet = new Set(keptIdxList);
      const kept = keptIdxList.map((idx) => group.items[idx]);
      survivingPerGroup[gi] = kept;
      groupCounts[gi] = kept.length;
      // Dropped items point at the surviving kept reply's *new* flat index.
      // Since `runningFlatIdx` is the flat index of the kept reply now,
      // every dropped index in this group maps to it.
      const keptFlatIdx = runningFlatIdx;
      droppedItemTargetByGroup[gi] = group.items.map((_, idx) =>
        keptIdxSet.has(idx) ? null : keptFlatIdx
      );
      runningFlatIdx += kept.length;
    }

    const flatItems: OptimizedChatItem[] = [];
    for (const items of survivingPerGroup) {
      for (const item of items) flatItems.push(item);
    }
    const maxFlat = Math.max(0, flatItems.length - 1);

    // Build `lastAssistantFlatIndexPerItem` aligned with the post-collapse
    // `flatItems`. The renderer uses this to mark the final reply for
    // the regenerate / turn-context plumbing. The tail group resolves to
    // `null` while the agent is streaming so the regenerate affordance
    // never flashes during an in-flight turn (matches the behaviour the
    // dedicated `useLastAssistantIndexByGroup` hook used to provide).
    const lastAssistantFlatIndexPerItem: (number | null)[] = new Array(
      flatItems.length
    ).fill(null);
    {
      let cursor = 0;
      const lastGroupIdx = groups.length - 1;
      for (let gi = 0; gi < groups.length; gi++) {
        const items = survivingPerGroup[gi];
        const isTail = gi === lastGroupIdx;
        let lastIdx: number | null = null;
        if (!(isTail && isAgentWorking)) {
          for (let i = items.length - 1; i >= 0; i--) {
            if (isCompletedAssistantMessage(items[i])) {
              lastIdx = cursor + i;
              break;
            }
          }
        }
        for (let i = 0; i < items.length; i++) {
          lastAssistantFlatIndexPerItem[cursor + i] = lastIdx;
        }
        cursor += items.length;
      }
    }

    // Build originalToFlatIndex from optimizedChatHistory indices (which
    // include user-message headers AND body items) to post-collapse flat
    // indices. User-message indices map to the first surviving body item
    // of their group; dropped body items map to the kept item's flat
    // index; surviving body items map to their own flat index.
    const originalToFlatIndex = new Map<number, number>();
    let origIdx = 0;
    let flatIdxCursor = 0;
    for (let gi = 0; gi < groups.length; gi++) {
      const group = groups[gi];
      const surviving = survivingPerGroup[gi];
      const droppedTargets = droppedItemTargetByGroup[gi];

      if (group.header) {
        // Header maps to the first surviving item of the group; if the
        // group is empty, it clamps to the nearest valid flat index.
        originalToFlatIndex.set(origIdx, Math.min(flatIdxCursor, maxFlat));
        origIdx++;
      }

      let localKeptCursor = flatIdxCursor;
      for (let i = 0; i < group.items.length; i++) {
        const droppedTarget = droppedTargets[i];
        if (droppedTarget !== null) {
          // Dropped: redirect to the surviving kept item's flat index.
          originalToFlatIndex.set(origIdx, droppedTarget);
        } else {
          originalToFlatIndex.set(origIdx, localKeptCursor);
          localKeptCursor++;
        }
        origIdx++;
      }
      flatIdxCursor += surviving.length;
    }

    let lastGroupFirstFlatIndex: number | null = null;
    if (groups.length > 0) {
      const tailSurviving = survivingPerGroup[survivingPerGroup.length - 1];
      if (tailSurviving.length > 0) {
        lastGroupFirstFlatIndex = flatItems.length - tailSurviving.length;
      }
    }

    return {
      groupCounts,
      groupHeaders,
      groupMeta,
      flatItems,
      totalFlatItems: flatItems.length,
      originalToFlatIndex,
      lastGroupFirstFlatIndex,
      lastAssistantFlatIndexPerItem,
    };
  }, [
    optimizedChatHistory,
    collapseOverrides,
    isAgentWorking,
    collapseTailWhenIdle,
    forceCollapseAllTurns,
    disableTurnCollapse,
    allTurnsCollapsed,
    defaultTurnCollapsed,
    isTurnBoundaryItem,
    isTurnHeaderItem,
  ]);
}

function parseEpochMs(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

const TURN_COLLAPSE_ITEM_COUNT_THRESHOLD = 10;

/**
 * Decide whether `groupIndex` should be eligible for the default shared
 * "Agent worked for …" collapse.
 *
 * Rules:
 * 1. Headerless preamble groups (no `turnId`) are never collapsed.
 * 2. Groups with one or fewer body items are never collapsed (nothing useful
 *    to hide behind a "Agent worked for …" control).
 * 3. Historical turns with multiple body events are collapsible by default.
 * 4. The tail (last) group is only collapsible after the caller marks the
 *    session idle long enough; until then the newest summary stays visible.
 * 5. Short-turn threshold only applies to the tail group after it idles.
 */
export function isTurnCollapseEligible(
  meta: ChatGroupMeta | undefined,
  groupIndex: number,
  groupCount: number,
  options: {
    collapseTailWhenIdle?: boolean;
    /** Force-collapse every multi-item turn regardless of tail/threshold
     *  gating. Used by read-only subagent panes. */
    forceCollapseAllTurns?: boolean;
  } = {}
): boolean {
  if (!meta) return false;
  if (meta.turnId === null) return false;
  const bodyItemCount = meta.unloadedTurn?.bodyEventCount ?? meta.itemCount;
  if (bodyItemCount <= 1) return false;

  // Read-only subagent panes opt in to "always collapsed" — once we know
  // the turn has more than one body item, skip the tail / streaming /
  // threshold checks that the main panel uses to keep the live tail
  // readable.
  if (options.forceCollapseAllTurns === true) return true;

  const isTailGroup = groupIndex >= groupCount - 1;
  if (!isTailGroup) return true;
  if (options.collapseTailWhenIdle !== true) return false;
  if (meta.unloadedTurn) return true;
  return meta.itemCount + 1 > TURN_COLLAPSE_ITEM_COUNT_THRESHOLD;
}
