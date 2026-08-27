/**
 * Pure fork-thread grouping for cloud-org remote sessions (sidebar view).
 *
 * Groups `RemoteTeammateSessionMetadata` rows into fork threads keyed on the
 * denormalized `forkedFrom.rootSessionId` (design §16.11) — the root key
 * survives the parent row falling out of the retention window. Descendants
 * of any depth sit FLAT under the root (no recursive tree), sorted by
 * recency; threads themselves sort by their most recent activity.
 */
import type { RemoteTeammateSessionMetadata } from "@src/store/collaboration/types";

export interface CloudSessionThreadRow {
  row: RemoteTeammateSessionMetadata;
  /** Canonical owner-side session id supplied by the cloud metadata row. */
  bareSessionId: string;
  /**
   * This fork's parent chain broke (root aged out AND no present direct
   * parent): it renders top-level with attribution ("forked from @X"),
   * possibly promoted to carry its own present subtree.
   */
  isOrphan: boolean;
}

export interface CloudSessionThread {
  /** Bare session id of the thread root (present or aged out). */
  rootKey: string;
  /** The true root, or the nearest present ancestor promoted as an orphan. */
  root: CloudSessionThreadRow;
  /** All descendants (any depth), flat, sorted by lastActivityAt desc. */
  descendants: CloudSessionThreadRow[];
}

export interface BuildCloudSessionThreadsOptions {
  /** ownerUserId to filter by; null/undefined ⇒ everyone. */
  memberFilter?: string | null;
  /** Local session ids on this device; matching own cloud rows are excluded. */
  localOwnSessionIds?: ReadonlySet<string>;
  /** Signed-in cloud user; local-device exclusion requires owner + session id. */
  viewerUserId?: string | null;
}

function activityTime(row: RemoteTeammateSessionMetadata): number {
  if (!row.lastActivityAt) return 0;
  const parsed = Date.parse(row.lastActivityAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function rootKeyOf(row: RemoteTeammateSessionMetadata): string {
  return row.forkedFrom?.rootSessionId ?? row.sourceSessionId;
}

/** Distinct owners per conversation family, before any viewer exclusion. */
function familyOwnerCounts(
  rows: readonly RemoteTeammateSessionMetadata[]
): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const row of rows) {
    if (row.deletedAt) continue;
    const key = rootKeyOf(row);
    const set = owners.get(key) ?? new Set<string>();
    set.add(row.ownerUserId);
    owners.set(key, set);
  }
  return owners;
}

/**
 * Viewer-owned bare session ids that belong to a MULTI-owner conversation
 * family. Those conversations graduate to Team Sessions (one thread row for
 * the whole family), so My Sessions hides these ids — one conversation, one
 * sidebar entry.
 */
export function collectTeamConversationSessionIds(
  rows: readonly RemoteTeammateSessionMetadata[],
  viewerUserId: string | null | undefined
): Set<string> {
  const result = new Set<string>();
  if (!viewerUserId) return result;
  const owners = familyOwnerCounts(rows);
  for (const row of rows) {
    if (row.deletedAt || row.ownerUserId !== viewerUserId) continue;
    if ((owners.get(rootKeyOf(row))?.size ?? 1) >= 2) {
      result.add(row.sourceSessionId);
    }
  }
  return result;
}

/** Ordered thread list for one cloud org's remote session rows. */
export function buildCloudSessionThreads(
  rows: readonly RemoteTeammateSessionMetadata[],
  {
    memberFilter = null,
    localOwnSessionIds,
    viewerUserId,
  }: BuildCloudSessionThreadsOptions = {}
): CloudSessionThread[] {
  const byRootKey = new Map<
    string,
    { root: CloudSessionThreadRow | null; descendants: CloudSessionThreadRow[] }
  >();

  const familyOwners = familyOwnerCounts(rows);
  for (const row of rows) {
    if (row.deletedAt) continue;
    const bareSessionId = row.sourceSessionId;
    const rootKey = rootKeyOf(row);
    // Solo sessions stay remote-only here: this device's own local rows
    // live in My Sessions, while the same account's sessions from another
    // device (no matching local id) remain visible. A MULTI-owner family is
    // different — it IS a team conversation, so the viewer's own member
    // rows join the thread and My Sessions hides them instead (one
    // conversation, one sidebar entry, with the badge and thread intact).
    if (
      viewerUserId &&
      row.ownerUserId === viewerUserId &&
      localOwnSessionIds?.has(bareSessionId) &&
      (familyOwners.get(rootKey)?.size ?? 1) < 2
    ) {
      continue;
    }
    const threadRow: CloudSessionThreadRow = {
      row,
      bareSessionId,
      isOrphan: false,
    };
    let bucket = byRootKey.get(rootKey);
    if (!bucket) {
      bucket = { root: null, descendants: [] };
      byRootKey.set(rootKey, bucket);
    }
    if (bareSessionId === rootKey) {
      bucket.root = threadRow;
    } else {
      bucket.descendants.push(threadRow);
    }
  }

  const threads: CloudSessionThread[] = [];
  for (const [rootKey, bucket] of byRootKey) {
    bucket.descendants.sort(
      (a, b) => activityTime(b.row) - activityTime(a.row)
    );
    if (bucket.root) {
      threads.push({
        rootKey,
        root: bucket.root,
        descendants: bucket.descendants,
      });
      continue;
    }
    // Root aged out (retention window). Don't flatten the whole bucket:
    // promote each descendant whose DIRECT parent is also absent to a
    // top-level orphan root (attributed "forked from @X"), and nest every
    // row whose parent chain reaches it flat underneath — a fork of a
    // visible fork must render under that fork, not beside it.
    const presentByBareId = new Map(
      bucket.descendants.map((descendant) => [
        descendant.bareSessionId,
        descendant,
      ])
    );
    const childrenByParent = new Map<string, CloudSessionThreadRow[]>();
    const topLevel: CloudSessionThreadRow[] = [];
    for (const descendant of bucket.descendants) {
      const parentId = descendant.row.forkedFrom?.sourceSessionId;
      if (parentId && presentByBareId.has(parentId)) {
        const siblings = childrenByParent.get(parentId) ?? [];
        siblings.push(descendant);
        childrenByParent.set(parentId, siblings);
      } else {
        topLevel.push({ ...descendant, isOrphan: true });
      }
    }
    // Sibling orphans (several forks of the SAME dead root) are one
    // conversation, not several: promote the OLDEST fork — the same
    // deterministic anchor the comment plane falls back to — and nest the
    // rest flat underneath it.
    const promotionOrder = [...topLevel].sort((left, right) => {
      const leftAt = Date.parse(left.row.forkedFrom?.forkedAt ?? "");
      const rightAt = Date.parse(right.row.forkedFrom?.forkedAt ?? "");
      const delta =
        (Number.isNaN(leftAt) ? 0 : leftAt) -
        (Number.isNaN(rightAt) ? 0 : rightAt);
      return delta || left.bareSessionId.localeCompare(right.bareSessionId);
    });
    const claimed = new Set<string>();
    const orphanRoot = promotionOrder[0];
    if (orphanRoot) {
      // Flatten the promoted root's subtree (any depth). The visited set
      // guards against malformed forkedFrom cycles in pushed payloads.
      const subtree: CloudSessionThreadRow[] = [];
      const queue = [orphanRoot.bareSessionId];
      for (const sibling of promotionOrder.slice(1)) {
        claimed.add(sibling.bareSessionId);
        subtree.push(sibling);
        queue.push(sibling.bareSessionId);
      }
      while (queue.length > 0) {
        const parentId = queue.shift() as string;
        for (const child of childrenByParent.get(parentId) ?? []) {
          if (claimed.has(child.bareSessionId)) continue;
          claimed.add(child.bareSessionId);
          subtree.push(child);
          queue.push(child.bareSessionId);
        }
      }
      subtree.sort((a, b) => activityTime(b.row) - activityTime(a.row));
      threads.push({
        rootKey: orphanRoot.bareSessionId,
        root: orphanRoot,
        descendants: subtree,
      });
    }
    // Rows stranded by a forkedFrom cycle (never reached from any top-level
    // row): render top-level rather than vanish.
    for (const descendant of bucket.descendants) {
      if (
        claimed.has(descendant.bareSessionId) ||
        topLevel.some(
          (orphanRoot) => orphanRoot.bareSessionId === descendant.bareSessionId
        )
      ) {
        continue;
      }
      threads.push({
        rootKey: descendant.bareSessionId,
        root: { ...descendant, isOrphan: true },
        descendants: [],
      });
    }
  }

  // Member filter keeps a thread when ANY row in it matches, and then keeps
  // ALL of that thread's rows — thread integrity beats strict filtering (a
  // fork without its parent context would be unreadable attribution-wise).
  const memberFiltered = memberFilter
    ? threads.filter((thread) =>
        [thread.root, ...thread.descendants].some(
          (threadRow) => threadRow.row.ownerUserId === memberFilter
        )
      )
    : threads;

  const threadTime = (thread: CloudSessionThread): number =>
    Math.max(
      activityTime(thread.root.row),
      ...thread.descendants.map((descendant) => activityTime(descendant.row)),
      0
    );
  memberFiltered.sort((a, b) => threadTime(b) - threadTime(a));
  return memberFiltered;
}

/**
 * Session ids proven to originate on this device for one cloud org.
 *
 * `sessions` is only the currently loaded sidebar roster, so it cannot be the
 * sole source: older/paginated sessions would otherwise reappear as Team
 * Conversations. Push markers and segment cursors are persisted locally and
 * survive that pagination, making them the durable device-origin registry.
 */
export function collectCurrentDeviceCloudSessionIds(
  orgId: string,
  sessions: readonly { session_id: string }[],
  pushedMetadata: Readonly<Record<string, true>>,
  pushCursors: Readonly<Record<string, { orgId: string; sessionId: string }>>
): Set<string> {
  const ids = new Set(sessions.map((session) => session.session_id));
  const keyPrefix = `${orgId}:`;

  for (const [key, pushed] of Object.entries(pushedMetadata)) {
    if (pushed && key.startsWith(keyPrefix)) {
      ids.add(key.slice(keyPrefix.length));
    }
  }
  for (const cursor of Object.values(pushCursors)) {
    if (cursor.orgId === orgId) ids.add(cursor.sessionId);
  }

  return ids;
}

/**
 * Exact local rows needed for the currently visible My Conversations page.
 *
 * Cloud rows are already ordered by activity. Qualifying loaded rows still
 * consume a visible slot; only missing rows are returned for exact hydration.
 */
export function collectCurrentDeviceSessionsToHydrate(
  rows: readonly RemoteTeammateSessionMetadata[],
  viewerUserId: string | null | undefined,
  currentDeviceSessionIds: ReadonlySet<string>,
  loadedSessionIds: ReadonlySet<string>,
  visibleLimit: number
): string[] {
  if (!viewerUserId || visibleLimit <= 0) return [];

  const seen = new Set<string>();
  const missing: string[] = [];
  let visibleOwnRows = 0;
  for (const row of rows) {
    const sessionId = row.sourceSessionId;
    if (
      row.deletedAt ||
      row.ownerUserId !== viewerUserId ||
      !currentDeviceSessionIds.has(sessionId) ||
      seen.has(sessionId)
    ) {
      continue;
    }
    seen.add(sessionId);
    if (visibleOwnRows >= visibleLimit) break;
    visibleOwnRows += 1;
    if (!loadedSessionIds.has(sessionId)) missing.push(sessionId);
  }
  return missing;
}

/**
 * A remote thread row is disabled when it has no published replay segments.
 */
export function isCloudThreadRowDisabled(
  threadRow: CloudSessionThreadRow
): boolean {
  return threadRow.row.eventsEpoch === undefined;
}

/**
 * Local rows that must not render in the cloud scope's flat "My Sessions"
 * section.
 *
 * Writable local sessions always remain in My Sessions. Only teammate replay
 * caches are excluded: their remote source row is the Team Conversations
 * entry, while the local Session is read-only implementation detail.
 */
export function collectCloudFlatListExcludedSessionIds(
  sessions: readonly {
    session_id: string;
    importedFrom?: { orgId: string };
  }[],
  orgId: string
): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    if (session.importedFrom?.orgId === orgId) {
      ids.add(session.session_id);
    }
  }
  return ids;
}
