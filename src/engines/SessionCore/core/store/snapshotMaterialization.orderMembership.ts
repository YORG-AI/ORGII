/**
 * Order/membership bookkeeping for `snapshotMaterialization.ts`.
 *
 * Tracks which of the chat / messages / simulator ordered views each event
 * belongs to (a small bitmask keyed by event id), and provides the
 * sorted-insertion helpers plus chat/simulator comparators used to keep
 * those id lists ordered as deltas are applied incrementally.
 */
import type { SessionEvent } from "../types";
import type {
  NormalizedSnapshotCache,
  SnapshotEventMembership,
} from "./EventStoreProxyTypes";

export function sameIdList(previous: string[], next: string[]): boolean {
  if (previous === next) return true;
  if (previous.length !== next.length) return false;
  for (let index = 0; index < previous.length; index++) {
    if (previous[index] !== next[index]) return false;
  }
  return true;
}

export const ORDER_MEMBER_CHAT = 1;
export const ORDER_MEMBER_MESSAGES = 2;
export const ORDER_MEMBER_SIMULATOR = 4;

export function buildOrderMembership(
  chatEventIds: string[],
  messagesEventIds: string[],
  simulatorEventIds: string[]
): Map<string, number> {
  const result = new Map<string, number>();
  const add = (ids: string[], flag: number) => {
    for (const id of ids) result.set(id, (result.get(id) ?? 0) | flag);
  };
  add(chatEventIds, ORDER_MEMBER_CHAT);
  add(messagesEventIds, ORDER_MEMBER_MESSAGES);
  add(simulatorEventIds, ORDER_MEMBER_SIMULATOR);
  return result;
}

export function membershipBits(membership: SnapshotEventMembership): number {
  return (
    (membership.chat ? ORDER_MEMBER_CHAT : 0) |
    (membership.messages ? ORDER_MEMBER_MESSAGES : 0) |
    (membership.simulator ? ORDER_MEMBER_SIMULATOR : 0)
  );
}

export function removeId(ids: string[], id: string): number {
  const index = ids.indexOf(id);
  if (index >= 0) ids.splice(index, 1);
  return index;
}

export function placeIdAtIndex(
  ids: string[],
  id: string,
  targetIndex: number
): boolean {
  if (ids[targetIndex] === id) return false;
  const previousIndex = removeId(ids, id);
  const nextIndex = Math.max(0, Math.min(targetIndex, ids.length));
  ids.splice(nextIndex, 0, id);
  return previousIndex !== nextIndex;
}

export function chatSortRank(event: SessionEvent): number {
  return event.displayVariant === "summary" ||
    event.functionName === "turn_summary" ||
    event.uiCanonical === "turn_summary"
    ? 1
    : 0;
}

export function compareChatEvents(
  left: SessionEvent,
  right: SessionEvent
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    chatSortRank(left) - chatSortRank(right) ||
    left.id.localeCompare(right.id)
  );
}

export function compareSimulatorEvents(
  left: SessionEvent,
  right: SessionEvent
): number {
  return (
    left.createdAt.localeCompare(right.createdAt) ||
    left.id.localeCompare(right.id)
  );
}

export function placeSortedId(
  ids: string[],
  id: string,
  visible: boolean,
  eventsById: Map<string, SessionEvent>,
  compare: (left: SessionEvent, right: SessionEvent) => number
): boolean {
  const previousIndex = removeId(ids, id);
  if (!visible) return previousIndex >= 0;
  const event = eventsById.get(id);
  if (!event) return previousIndex >= 0;
  const nextIndex = ids.findIndex((otherId) => {
    const other = eventsById.get(otherId);
    return other ? compare(event, other) < 0 : false;
  });
  const insertionIndex = nextIndex < 0 ? ids.length : nextIndex;
  ids.splice(insertionIndex, 0, id);
  return previousIndex !== insertionIndex;
}

export function placeMessageId(
  cache: NormalizedSnapshotCache,
  id: string,
  visible: boolean,
  eventIndex: number
): boolean {
  const previousIndex = removeId(cache.messagesEventIds, id);
  if (!visible) return previousIndex >= 0;
  const eventPositionById = new Map(
    cache.eventIds.map((eventId, index) => [eventId, index])
  );
  const nextIndex = cache.messagesEventIds.findIndex((otherId) => {
    const otherIndex = eventPositionById.get(otherId);
    return otherIndex !== undefined && otherIndex > eventIndex;
  });
  const insertionIndex =
    nextIndex < 0 ? cache.messagesEventIds.length : nextIndex;
  cache.messagesEventIds.splice(insertionIndex, 0, id);
  return previousIndex !== insertionIndex;
}
