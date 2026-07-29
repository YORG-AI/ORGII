import type { Person } from "@src/types/core/shared";

import type { TimelineEntry } from "./types";

export interface TimelineActorVisual {
  avatar?: string;
  color?: string;
}

function normalizeActorName(name: string): string {
  return name.trim().toLocaleLowerCase();
}

export function isCurrentTimelineActor(
  entry: TimelineEntry,
  currentUser: Person
): boolean {
  if (entry.actorId && entry.actorId === currentUser.id) {
    return true;
  }

  return (
    normalizeActorName(entry.userName) === normalizeActorName(currentUser.name)
  );
}

/**
 * Current member data is the canonical visual identity. Persisted timeline
 * events may predate a profile/color update or contain only a neutral fallback.
 */
export function resolveTimelineActorVisual(
  entry: TimelineEntry,
  currentUser: Person
): TimelineActorVisual {
  if (!isCurrentTimelineActor(entry, currentUser)) {
    return {
      avatar: entry.userAvatar,
      color: entry.userColor,
    };
  }

  return {
    avatar: currentUser.avatar ?? entry.userAvatar,
    color: currentUser.color ?? entry.userColor,
  };
}
