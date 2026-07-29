import { WORK_ITEM_HISTORY_ACTION } from "@src/api/http/project/types";

import type { TimelineEntry } from "./types";

const OS_AGENT_USERNAME = "os-agent";
const DELEGATION_PREFIX = "Delegation";

function isDelegationActor(entry: TimelineEntry): boolean {
  if (entry.actorId) return entry.actorId === OS_AGENT_USERNAME;
  return entry.userName === OS_AGENT_USERNAME;
}

export function isDiscussionEntry(entry: TimelineEntry): boolean {
  if (entry.type !== WORK_ITEM_HISTORY_ACTION.COMMENTED) return false;

  return !(
    isDelegationActor(entry) &&
    entry.descriptions[0]?.startsWith(DELEGATION_PREFIX)
  );
}

export function partitionDiscussionTimeline(
  entries: readonly TimelineEntry[]
): {
  discussionEntries: TimelineEntry[];
  activityEntries: TimelineEntry[];
} {
  const discussionEntries: TimelineEntry[] = [];
  const activityEntries: TimelineEntry[] = [];

  for (const entry of entries) {
    (isDiscussionEntry(entry) ? discussionEntries : activityEntries).push(
      entry
    );
  }

  return { discussionEntries, activityEntries };
}
