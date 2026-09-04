import dayjs from "dayjs";
import { useAtomValue } from "jotai";
import React, { memo, useMemo } from "react";

import { currentEventAtom, replayModeAtom } from "@src/engines/SessionCore";

import { STATUS_BAR_TEXT_20 } from "./tokens";

export const ReplayTimestampSegment: React.FC = memo(() => {
  const replayMode = useAtomValue(replayModeAtom);
  const currentEvent = useAtomValue(currentEventAtom);

  const currentTimestamp = useMemo(() => {
    if (replayMode !== "replay" || !currentEvent?.createdAt) return "";
    // Compact wall-clock only — the date side was visually noisy
    // ("Today 14:23:05") and the user is always in a single session
    // context where the date is implied by the slider position.
    return dayjs(currentEvent.createdAt).format("HH:mm:ss");
  }, [currentEvent, replayMode]);

  if (!currentTimestamp) return null;

  // Fixed width (matches the widest HH:mm:ss at 11px) so transitions
  // between e.g. "1:02:09" and "12:34:56" never reflow the rest of
  // the pill. `tabular-nums` keeps digit columns aligned within the
  // box; the wrapper centers the text so unused space lives on both
  // sides rather than wobbling to one edge.
  return (
    <span
      className={`inline-flex h-5 w-[54px] shrink-0 items-center justify-center ${STATUS_BAR_TEXT_20} leading-none text-text-2 tabular-nums`}
    >
      {currentTimestamp}
    </span>
  );
});

ReplayTimestampSegment.displayName = "ReplayTimestampSegment";
