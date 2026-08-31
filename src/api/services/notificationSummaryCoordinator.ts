import type {
  BackgroundCompletionSummary,
  NotificationSettings,
} from "@src/types/ui/notification";

import { isQuietHoursActive, nextQuietHoursEnd } from "./notificationPolicy";

const MAX_SUMMARY_COUNT = 999;
const MAX_SUMMARY_NAMES = 3;
const MAX_SUMMARY_NAME_LENGTH = 120;
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface BackgroundCompletionSummaryEntry {
  eventKey: string;
  sessionName: string;
}

type DeliverSummary = (
  summary: BackgroundCompletionSummary,
  settings: NotificationSettings
) => Promise<boolean> | boolean;

export class BackgroundCompletionSummaryCoordinator {
  private settings: NotificationSettings | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private timerGeneration = 0;
  private flushInFlight = false;
  private readonly pendingEntries = new Map<
    string,
    BackgroundCompletionSummaryEntry
  >();

  constructor(
    private readonly deliverSummary: DeliverSummary,
    private readonly now: () => Date = () => new Date()
  ) {}

  configure(settings: NotificationSettings): void {
    this.settings = settings;
    this.reconcile();
  }

  enqueue(
    entry: BackgroundCompletionSummaryEntry,
    settings: NotificationSettings
  ): void {
    this.settings = settings;
    if (
      !this.pendingEntries.has(entry.eventKey) &&
      this.pendingEntries.size < MAX_SUMMARY_COUNT
    ) {
      const sessionName = entry.sessionName.trim().replace(/\s+/g, " ");
      this.pendingEntries.set(entry.eventKey, {
        eventKey: entry.eventKey,
        sessionName:
          sessionName.slice(0, MAX_SUMMARY_NAME_LENGTH) || "Background session",
      });
    }
    this.reconcile();
  }

  dispose(): void {
    this.clearTimer();
    this.clearPending();
    this.settings = null;
  }

  getPendingSummary(): BackgroundCompletionSummary | null {
    return this.summarize(this.pendingEntries.values());
  }

  private summarize(
    entries: Iterable<BackgroundCompletionSummaryEntry>
  ): BackgroundCompletionSummary | null {
    let count = 0;
    const sessionNames: string[] = [];
    for (const entry of entries) {
      count += 1;
      if (
        sessionNames.length < MAX_SUMMARY_NAMES &&
        !sessionNames.includes(entry.sessionName)
      ) {
        sessionNames.push(entry.sessionName);
      }
    }
    if (count === 0) return null;
    return {
      count,
      sessionNames,
    };
  }

  private reconcile(): void {
    const settings = this.settings;
    if (!settings || this.pendingEntries.size === 0) {
      this.clearTimer();
      return;
    }

    if (
      !settings.enabled ||
      !settings.categories.taskCompletion ||
      !settings.backgroundCompletionSummary ||
      settings.criticalOnly
    ) {
      this.clearTimer();
      this.clearPending();
      return;
    }

    if (this.flushInFlight) return;

    const now = this.now();
    if (!isQuietHoursActive(settings, now)) {
      void this.flush(settings);
      return;
    }

    const quietEnd = nextQuietHoursEnd(settings, now);
    if (!quietEnd) {
      void this.flush(settings);
      return;
    }

    this.clearTimer();
    const delay = Math.min(
      MAX_TIMEOUT_MS,
      Math.max(0, quietEnd.getTime() - now.getTime())
    );
    const generation = ++this.timerGeneration;
    this.timer = setTimeout(() => {
      if (generation !== this.timerGeneration) return;
      this.timer = null;
      this.reconcile();
    }, delay);
  }

  private async flush(settings: NotificationSettings): Promise<void> {
    if (this.flushInFlight) return;
    const snapshot = Array.from(this.pendingEntries.entries());
    const summary = this.summarize(snapshot.map(([, entry]) => entry));
    if (!summary || snapshot.length === 0) return;

    this.clearTimer();
    this.flushInFlight = true;
    let acknowledged = false;
    try {
      acknowledged = await this.deliverSummary(summary, settings);
    } catch {
      acknowledged = false;
    } finally {
      this.flushInFlight = false;
    }

    if (acknowledged) {
      for (const [eventKey] of snapshot) {
        this.pendingEntries.delete(eventKey);
      }
    }

    const latestSettings = this.settings;
    if (!latestSettings || this.pendingEntries.size === 0) return;
    if (acknowledged || isQuietHoursActive(latestSettings, this.now())) {
      this.reconcile();
    }
  }

  private clearTimer(): void {
    this.timerGeneration += 1;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private clearPending(): void {
    this.pendingEntries.clear();
  }
}
