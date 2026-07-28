import { useAtomValue } from "jotai";
import React, { memo } from "react";

import { hasLoadedMoreActivitiesAtom } from "@src/store/ui/sessionPaginationAtom";

import { turnMetadataAtomFamily, turnMetadataKey } from "../turnMetadataAtom";
import TurnMetadataFooter from "./TurnMetadataFooter";
import { isTerminalTurnStatus } from "./TurnMetadataFooter/turnFinality";

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
    if (!sessionId || !summary || !isTerminalTurnStatus(summary.status))
      return null;
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
