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

import { cloudSessionIdFromRowId } from "./org2CloudBackendAdapter";

export interface CloudSessionThreadRow {
  row: RemoteTeammateSessionMetadata;
  /** Bare session id (owner-side) — `cloudSessionIdFromRowId(row.id)`. */
  bareSessionId: string;
  /**
   * The bare id matches one of the viewer's LOCAL sessions — the sidebar
   * routes clicks locally and hides the duplicate from the flat local list.
   */
  isMine: boolean;
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
  /** Local session ids present on the viewer's machine. */
  localOwnSessionIds?: ReadonlySet<string>;
  /** Signed-in cloud user; ownership requires both user id and session id. */
  viewerUserId?: string | null;
}

function activityTime(row: RemoteTeammateSessionMetadata): number {
  if (!row.lastActivityAt) return 0;
  const parsed = Date.parse(row.lastActivityAt);
  return Number.isNaN(parsed) ? 0 : parsed;
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

  for (const row of rows) {
    if (row.deletedAt) continue;
    const bareSessionId = cloudSessionIdFromRowId(row.id);
    const rootKey = row.forkedFrom?.rootSessionId ?? bareSessionId;
    const threadRow: CloudSessionThreadRow = {
      row,
      bareSessionId,
      // Two ORGII instances on the same Mac intentionally see the same
      // Codex/Claude history and therefore the same source session id. An id
      // collision alone does not make a teammate-owned cloud row local: the
      // authenticated owner must match too, or a directed share disappears
      // from the recipient's TEAM SESSIONS list as a false "solo mine" row.
      isMine:
        Boolean(viewerUserId) &&
        row.ownerUserId === viewerUserId &&
        (localOwnSessionIds?.has(bareSessionId) ?? false),
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
    const claimed = new Set<string>();
    for (const orphanRoot of topLevel) {
      // Flatten the promoted root's subtree (any depth). The visited set
      // guards against malformed forkedFrom cycles in pushed payloads.
      const subtree: CloudSessionThreadRow[] = [];
      const queue = [orphanRoot.bareSessionId];
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

  // TEAM section = collaboration context. A thread whose every row is the
  // viewer's OWN session (a solo shared session nobody forked) must NOT
  // relocate into the team section — it stays in the flat local list
  // (collectThreadedLocalSessionIds derives from the returned threads, so
  // dropping the thread here returns the session to the local list). The
  // viewer's own rows still render here once a TEAMMATE row shares the
  // thread: a fork thread without its root is unreadable.
  const filtered = memberFiltered.filter((thread) =>
    [thread.root, ...thread.descendants].some((threadRow) => !threadRow.isMine)
  );

  const threadTime = (thread: CloudSessionThread): number =>
    Math.max(
      activityTime(thread.root.row),
      ...thread.descendants.map((descendant) => activityTime(descendant.row)),
      0
    );
  filtered.sort((a, b) => threadTime(b) - threadTime(a));
  return filtered;
}

/**
 * A thread row is disabled only when it is a TEAMMATE row without published
 * segments. Rows that are MINE route to the LOCAL session on click and need
 * no published segments, so they are never disabled.
 */
export function isCloudThreadRowDisabled(
  threadRow: CloudSessionThreadRow
): boolean {
  return !threadRow.isMine && threadRow.row.eventsEpoch === undefined;
}

/**
 * Local session ids that actually RENDER at a threaded position in the given
 * (already member-filtered) thread list. The sidebar hides exactly these from
 * the flat local list — a session is excluded only if it is visible in the
 * team section, so a member filter that drops a thread returns the viewer's
 * own sessions to the flat list instead of vanishing them from both.
 */
export function collectThreadedLocalSessionIds(
  threads: readonly CloudSessionThread[]
): Set<string> {
  const ids = new Set<string>();
  for (const thread of threads) {
    for (const threadRow of [thread.root, ...thread.descendants]) {
      if (threadRow.isMine) ids.add(threadRow.bareSessionId);
    }
  }
  return ids;
}

/**
 * Local rows that must not render in the cloud scope's flat "My Sessions"
 * section.
 *
 * A writable session owned by the viewer is excluded only while it actually
 * renders inside a visible team thread. A teammate replay is different: its
 * local `Session` is a read-only cache, not an owned session, so provenance
 * excludes it regardless of Team-section filters or pagination.
 */
export function collectCloudFlatListExcludedSessionIds(
  threads: readonly CloudSessionThread[],
  sessions: readonly {
    session_id: string;
    importedFrom?: { orgId: string };
  }[],
  orgId: string
): Set<string> {
  const ids = collectThreadedLocalSessionIds(threads);
  for (const session of sessions) {
    if (session.importedFrom?.orgId === orgId) {
      ids.add(session.session_id);
    }
  }
  return ids;
}
