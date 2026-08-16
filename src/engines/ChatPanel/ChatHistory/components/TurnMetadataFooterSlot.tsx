import { useAtomValue } from "jotai";
import React, { memo } from "react";

import { chatTurnMetadataVisibleAtom } from "@src/store/ui/chatPanelAtom";
import { hasLoadedMoreActivitiesAtom } from "@src/store/ui/sessionPaginationAtom";

import { turnMetadataAtomFamily, turnMetadataKey } from "../turnMetadataAtom";
import TurnMetadataFooter from "./TurnMetadataFooter";
import { isTerminalTurnStatus } from "./TurnMetadataFooter/turnFinality";

interface TurnMetadataFooterSlotProps {
  sessionId: string | null;
  turnId: string;
  isLastGroup: boolean;
}

interface TurnMetadataFooterSlotBodyProps {
  sessionId: string;
  turnId: string;
  isLastGroup: boolean;
}

/**
 * Inner body: only touches `turnMetadataAtomFamily` with a real session id.
 * The outer slot used to call the family with `sessionId ?? ""`, creating
 * `"\u0000<turnId>"` entries that `TurnMetadataLoader` (the family's GC
 * owner) never retains or removes — pinned for the app lifetime, one per
 * turn rendered while the session id was still null.
 */
const TurnMetadataFooterSlotBody: React.FC<TurnMetadataFooterSlotBodyProps> =
  memo(({ sessionId, turnId, isLastGroup }) => {
    const summary = useAtomValue(
      turnMetadataAtomFamily(turnMetadataKey(sessionId, turnId))
    );
    const hasLoadedMoreActivities = useAtomValue(hasLoadedMoreActivitiesAtom);
    if (!summary || !isTerminalTurnStatus(summary.status)) return null;
    return (
      <TurnMetadataFooter
        summary={summary}
        sessionId={sessionId}
        turnId={turnId}
        isPagedHistoryRound={hasLoadedMoreActivities && !isLastGroup}
      />
    );
  });

TurnMetadataFooterSlotBody.displayName = "TurnMetadataFooterSlotBody";

const TurnMetadataFooterSlot: React.FC<TurnMetadataFooterSlotProps> = memo(
  ({ sessionId, turnId, isLastGroup }) => {
    const turnMetadataVisible = useAtomValue(chatTurnMetadataVisibleAtom);
    if (!turnMetadataVisible || !sessionId) return null;
    return (
      <TurnMetadataFooterSlotBody
        sessionId={sessionId}
        turnId={turnId}
        isLastGroup={isLastGroup}
      />
    );
  }
);

TurnMetadataFooterSlot.displayName = "TurnMetadataFooterSlot";

export default TurnMetadataFooterSlot;
