import { useAtomValue } from "jotai";
import React, { memo, useEffect, useMemo, useState } from "react";

import { lastEventAtom } from "@src/engines/SessionCore/core/atoms";
import {
  ACTIVE_EXTERNAL_SESSION_REFRESH_INTERVAL_MS,
  activeExternalSessionRefreshFrequencyAtom,
} from "@src/store/session/dataSourceConfigAtom";
import { hasLoadedMoreActivitiesAtom } from "@src/store/ui/sessionPaginationAtom";
import { isImportedHistorySession } from "@src/util/session/sessionDispatch";

import { turnMetadataAtomFamily, turnMetadataKey } from "../turnMetadataAtom";
import TurnMetadataFooter from "./TurnMetadataFooter";
import { externalTurnMetadataReadyAt } from "./TurnMetadataFooter/externalVisibility";

interface TurnMetadataFooterSlotProps {
  sessionId: string | null;
  turnId: string;
  isLastGroup: boolean;
}

const TurnMetadataFooterSlot: React.FC<TurnMetadataFooterSlotProps> = memo(
  ({ sessionId, turnId, isLastGroup }) => {
    const summary = useAtomValue(
      turnMetadataAtomFamily(turnMetadataKey(sessionId ?? "", turnId))
    );
    const hasLoadedMoreActivities = useAtomValue(hasLoadedMoreActivitiesAtom);
    const lastEvent = useAtomValue(lastEventAtom);
    const activeExternalSessionRefreshFrequency = useAtomValue(
      activeExternalSessionRefreshFrequencyAtom
    );
    const shouldDelayExternalTail = Boolean(
      sessionId && isLastGroup && isImportedHistorySession(sessionId)
    );
    const readyAt = useMemo(() => {
      if (
        !shouldDelayExternalTail ||
        !sessionId ||
        lastEvent?.sessionId !== sessionId
      ) {
        return null;
      }
      return externalTurnMetadataReadyAt(
        lastEvent.createdAt,
        ACTIVE_EXTERNAL_SESSION_REFRESH_INTERVAL_MS[
          activeExternalSessionRefreshFrequency
        ]
      );
    }, [
      activeExternalSessionRefreshFrequency,
      lastEvent,
      sessionId,
      shouldDelayExternalTail,
    ]);
    const [resolvedReadyAt, setResolvedReadyAt] = useState<number | null>(null);

    useEffect(() => {
      if (!shouldDelayExternalTail || readyAt === null) return;
      const remainingMs = Math.max(0, readyAt - Date.now());
      const timeoutId = window.setTimeout(
        () => setResolvedReadyAt(readyAt),
        remainingMs
      );
      return () => window.clearTimeout(timeoutId);
    }, [readyAt, shouldDelayExternalTail]);

    if (!sessionId || !summary) return null;
    if (
      shouldDelayExternalTail &&
      (readyAt === null || resolvedReadyAt !== readyAt)
    ) {
      return null;
    }
    return (
      <TurnMetadataFooter
        summary={summary}
        sessionId={sessionId}
        turnId={turnId}
        isPagedHistoryRound={hasLoadedMoreActivities && !isLastGroup}
      />
    );
  }
);

TurnMetadataFooterSlot.displayName = "TurnMetadataFooterSlot";

export default TurnMetadataFooterSlot;
