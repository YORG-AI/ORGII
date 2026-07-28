import { parseRawSessionEvent } from "@src/engines/SessionCore/core/schemas";
import type { Logger } from "@src/hooks/logger";

import type { SessionSyncRefs } from "./sessionSyncTypes";
import type { RawSessionEvent } from "./types";

export function routeSessionChannelEvent(
  raw: string,
  refs: Pick<SessionSyncRefs, "handlerRef">,
  logger: Logger
): void {
  if (!refs.handlerRef.current) {
    logger.rateLimited(
      "session-channel-no-handler",
      30_000,
      "dropped a delivered session channel frame: no handler mounted",
      raw.slice(0, 200)
    );
    return;
  }
  try {
    const parsed = parseRawSessionEvent(raw) as RawSessionEvent;
    refs.handlerRef.current.handleEvent(parsed);
  } catch (error) {
    logger.rateLimited(
      "session-channel-parse-failure",
      30_000,
      "dropped an unparseable session channel frame:",
      error
    );
  }
}
