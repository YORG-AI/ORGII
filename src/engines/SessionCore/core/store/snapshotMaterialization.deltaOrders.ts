/**
 * Incremental order/membership reconciliation for `snapshotMaterialization.ts`.
 *
 * Applies one delta envelope's `removedIds` and `memberships` to a
 * `NormalizedSnapshotCache`'s id lists in place (sorted insertion for the
 * chat/simulator views, index-targeted placement for the raw event and
 * messages views) and reports which of the four ordered views actually
 * changed, so the caller can decide what needs re-materializing.
 */
import type {
  NormalizedSnapshotCache,
  SnapshotDelta,
} from "./EventStoreProxyTypes";
import {
  ORDER_MEMBER_CHAT,
  ORDER_MEMBER_MESSAGES,
  ORDER_MEMBER_SIMULATOR,
  compareChatEvents,
  compareSimulatorEvents,
  membershipBits,
  placeIdAtIndex,
  placeMessageId,
  placeSortedId,
  removeId,
} from "./snapshotMaterialization.orderMembership";

export function applyIncrementalOrders(
  delta: SnapshotDelta,
  cache: NormalizedSnapshotCache,
  sortKeyChangedIds: Set<string>
): {
  eventOrderChanged: boolean;
  chatOrderChanged: boolean;
  messagesOrderChanged: boolean;
  simulatorOrderChanged: boolean;
} {
  let eventOrderChanged = false;
  let chatOrderChanged = false;
  let messagesOrderChanged = false;
  let simulatorOrderChanged = false;

  for (const id of delta.removedIds) {
    const currentMembership = cache.orderMembershipById.get(id) ?? 0;
    eventOrderChanged = removeId(cache.eventIds, id) >= 0 || eventOrderChanged;
    if (currentMembership & ORDER_MEMBER_CHAT) {
      chatOrderChanged =
        removeId(cache.chatEventIds, id) >= 0 || chatOrderChanged;
    }
    if (currentMembership & ORDER_MEMBER_MESSAGES) {
      messagesOrderChanged =
        removeId(cache.messagesEventIds, id) >= 0 || messagesOrderChanged;
    }
    if (currentMembership & ORDER_MEMBER_SIMULATOR) {
      simulatorOrderChanged =
        removeId(cache.sortedSimulatorEventIds, id) >= 0 ||
        simulatorOrderChanged;
    }
    cache.orderMembershipById.delete(id);
  }

  for (const membership of delta.memberships ?? []) {
    const previousMembership =
      cache.orderMembershipById.get(membership.id) ?? 0;
    const nextMembership = membershipBits(membership);
    const sortKeyChanged = sortKeyChangedIds.has(membership.id);
    eventOrderChanged =
      placeIdAtIndex(cache.eventIds, membership.id, membership.eventIndex) ||
      eventOrderChanged;
    if (
      Boolean(previousMembership & ORDER_MEMBER_CHAT) !== membership.chat ||
      (membership.chat && sortKeyChanged)
    ) {
      chatOrderChanged =
        placeSortedId(
          cache.chatEventIds,
          membership.id,
          membership.chat,
          cache.eventsById,
          compareChatEvents
        ) || chatOrderChanged;
    }
    if (
      Boolean(previousMembership & ORDER_MEMBER_SIMULATOR) !==
        membership.simulator ||
      (membership.simulator && sortKeyChanged)
    ) {
      simulatorOrderChanged =
        placeSortedId(
          cache.sortedSimulatorEventIds,
          membership.id,
          membership.simulator,
          cache.eventsById,
          compareSimulatorEvents
        ) || simulatorOrderChanged;
    }
    if (
      Boolean(previousMembership & ORDER_MEMBER_MESSAGES) !==
      membership.messages
    ) {
      messagesOrderChanged =
        placeMessageId(
          cache,
          membership.id,
          membership.messages,
          membership.eventIndex
        ) || messagesOrderChanged;
    }
    if (nextMembership === 0) {
      cache.orderMembershipById.delete(membership.id);
    } else {
      cache.orderMembershipById.set(membership.id, nextMembership);
    }
  }

  return {
    eventOrderChanged,
    chatOrderChanged,
    messagesOrderChanged,
    simulatorOrderChanged,
  };
}
