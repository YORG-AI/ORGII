import { Message } from "@src/components/Message";
import { eventStoreProxy } from "@src/engines/SessionCore/core/store/EventStoreProxy";
import {
  finishSessionSwitchTrace,
  markSessionSwitchTrace,
} from "@src/engines/SessionCore/performance/sessionSwitchPerformance";
import type { Logger } from "@src/hooks/logger";

import type { SessionLoadStateActions } from "./sessionSyncStateHelpers";
import {
  hydrateSessionStoreBeforeDisplay,
  loadOwnSessionInitialEvents,
} from "./sessionSyncUtils";

export function loadSessionWithoutAdapter(
  sessionId: string,
  abortController: AbortController,
  actions: Pick<
    SessionLoadStateActions,
    | "dispatchLoadSession"
    | "failSessionLoad"
    | "setLoadStatus"
    | "setWpReadOnly"
  >,
  logger: Logger
): void {
  const loadHistory = async () => {
    markSessionSwitchTrace(sessionId, "no-adapter-load-start");
    actions.setLoadStatus("loading");
    try {
      const cacheHit = await eventStoreProxy.switchSession(sessionId);
      markSessionSwitchTrace(sessionId, "rust-switch-complete", {
        cacheHit,
      });
      if (abortController.signal.aborted) return;
      const events = await loadOwnSessionInitialEvents(sessionId);
      markSessionSwitchTrace(sessionId, "persisted-history-complete", {
        eventCount: events.length,
      });
      if (abortController.signal.aborted) return;
      await hydrateSessionStoreBeforeDisplay(sessionId, events);
      markSessionSwitchTrace(sessionId, "rust-hydration-complete", {
        eventCount: events.length,
      });
      if (abortController.signal.aborted) return;
      markSessionSwitchTrace(sessionId, "data-ready", {
        eventCount: events.length,
      });
      actions.dispatchLoadSession({ sessionId, events });
      actions.setWpReadOnly(true);
    } catch (error) {
      if (abortController.signal.aborted) return;
      const detail = error instanceof Error ? error.message : String(error);
      finishSessionSwitchTrace(sessionId, "failed", {
        reason: "no-adapter-load-error",
      });
      logger.error(`failed to load session (no adapter) ${sessionId}:`, error);
      actions.failSessionLoad(detail);
      actions.setWpReadOnly(true);
      Message.error({
        content: `Failed to load session history: ${detail}`,
        duration: 5000,
      });
    }
  };

  void loadHistory();
}
