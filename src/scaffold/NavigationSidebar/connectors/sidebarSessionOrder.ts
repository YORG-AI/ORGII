import { atomWithStorage } from "jotai/utils";

import type { Session } from "@src/store/session";

import { createStorage } from "./sidebarGroupByAtom";
import { sortSessionsByActivity } from "./workstationSidebarData";

export const SESSION_SORT_MODES = ["priority", "updated", "manual"] as const;
export type SessionSortMode = (typeof SESSION_SORT_MODES)[number];
// Presentation preferences retain at most 5,000 identities, including unloaded rows.
const MAX_ORDERED_SESSIONS = 5000;
export function parseSessionOrder(raw: unknown): string[] {
  return Array.isArray(raw)
    ? [
        ...new Set(
          raw.filter(
            (id): id is string => typeof id === "string" && id.length > 0
          )
        ),
      ].slice(0, MAX_ORDERED_SESSIONS)
    : [];
}
export const sidebarSessionSortAtom = atomWithStorage<SessionSortMode>(
  "orgii:sidebarSessionSort",
  "updated",
  createStorage((raw) =>
    SESSION_SORT_MODES.includes(raw as SessionSortMode)
      ? (raw as SessionSortMode)
      : "updated"
  ),
  { getOnInit: true }
);
export const sidebarSessionOrderAtom = atomWithStorage<string[]>(
  "orgii:sidebarSessionOrder",
  [],
  createStorage(parseSessionOrder),
  { getOnInit: true }
);

export function reorderSessionIds(
  order: readonly string[],
  visibleIds: readonly string[],
  source: string,
  target: string,
  after: boolean
): string[] {
  if (
    source === target ||
    !visibleIds.includes(source) ||
    !visibleIds.includes(target)
  )
    return [...order];
  const ids = [...new Set([...order, ...visibleIds])].filter(
    (id) => id !== source
  );
  ids.splice(ids.indexOf(target) + (after ? 1 : 0), 0, source);
  // Keep the touched identity even when the preference reaches its bound.
  return parseSessionOrder(
    ids.length > MAX_ORDERED_SESSIONS
      ? ids.filter((id) => visibleIds.includes(id)).concat(ids)
      : ids
  );
}

export function sortSidebarSessions(
  sessions: readonly Session[],
  mode: SessionSortMode,
  order: readonly string[]
): Session[] {
  const sorted = sortSessionsByActivity(sessions);
  if (mode === "manual") {
    const ranks = new Map(order.map((id, index) => [id, index]));
    sorted.sort(
      (a, b) =>
        (ranks.get(a.session_id) ?? Infinity) -
        (ranks.get(b.session_id) ?? Infinity)
    );
  } else if (mode === "priority") {
    const rank = (session: Session) =>
      session.status === "waiting_for_user"
        ? 0
        : session.status === "running" || session.status === "in_progress"
          ? 1
          : 2;
    sorted.sort((a, b) => rank(a) - rank(b));
  }
  return sorted;
}
