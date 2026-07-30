import { getTeamInboxItemKey } from "./domain";
import type { TeamInboxItem } from "./domain";

const MAX_SEEN_NOTIFICATION_SIGNATURES = 1_000;
const NEW_EVENT_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export interface TeamInboxNotificationSnapshot {
  scopeKey: string | null;
  loading: boolean;
  items: readonly TeamInboxItem[];
}

/**
 * Detects newly-arrived Team Inbox events without notifying historical unread
 * rows during first load, scope switches, pagination, or remounts.
 */
export class TeamInboxNotificationTracker {
  private scopeKey: string | null = null;
  private initialized = false;
  private notificationFloorMs = 0;
  private presentItemKeys = new Set<string>();
  private readonly seenSignatures = new Set<string>();

  constructor(private readonly now: () => number = Date.now) {}

  observe(snapshot: TeamInboxNotificationSnapshot): TeamInboxItem[] {
    if (!snapshot.scopeKey || snapshot.loading) return [];

    if (snapshot.scopeKey !== this.scopeKey) {
      this.scopeKey = snapshot.scopeKey;
      this.initialized = false;
      this.notificationFloorMs = 0;
      this.presentItemKeys.clear();
      this.seenSignatures.clear();
    }

    const nextKeys = new Set(
      snapshot.items.map((item) => getTeamInboxItemKey(item))
    );
    const newestOccurredAtMs = newestTimestamp(snapshot.items);

    if (!this.initialized) {
      this.initialized = true;
      this.presentItemKeys = nextKeys;
      this.notificationFloorMs = Math.max(
        newestOccurredAtMs,
        this.now() - NEW_EVENT_CLOCK_SKEW_MS
      );
      this.rememberAll(snapshot.items);
      return [];
    }

    const candidates = snapshot.items.filter((item) => {
      const itemKey = getTeamInboxItemKey(item);
      const occurredAtMs = Date.parse(item.occurredAt);
      const signature = notificationSignature(item);
      return (
        item.readAt === null &&
        !this.presentItemKeys.has(itemKey) &&
        !this.seenSignatures.has(signature) &&
        Number.isFinite(occurredAtMs) &&
        occurredAtMs >= this.notificationFloorMs
      );
    });

    this.presentItemKeys = nextKeys;
    this.notificationFloorMs = Math.max(
      this.notificationFloorMs,
      newestOccurredAtMs
    );
    this.rememberAll(snapshot.items);
    return candidates;
  }

  private rememberAll(items: readonly TeamInboxItem[]): void {
    for (const item of items) {
      const signature = notificationSignature(item);
      this.seenSignatures.delete(signature);
      this.seenSignatures.add(signature);
    }
    while (this.seenSignatures.size > MAX_SEEN_NOTIFICATION_SIGNATURES) {
      const oldest = this.seenSignatures.values().next().value as
        | string
        | undefined;
      if (!oldest) break;
      this.seenSignatures.delete(oldest);
    }
  }
}

function notificationSignature(item: TeamInboxItem): string {
  return `${getTeamInboxItemKey(item)}:${item.occurredAt}`;
}

function newestTimestamp(items: readonly TeamInboxItem[]): number {
  let newest = 0;
  for (const item of items) {
    const occurredAtMs = Date.parse(item.occurredAt);
    if (Number.isFinite(occurredAtMs)) newest = Math.max(newest, occurredAtMs);
  }
  return newest;
}
