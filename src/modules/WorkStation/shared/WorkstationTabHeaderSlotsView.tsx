import React, { memo } from "react";

import type { WorkstationTabHeaderSlots } from "@src/store/workstation";

import { NoDragRegion } from "./NoDragRegion";

interface WorkstationTabHeaderSlotsViewProps {
  slots: WorkstationTabHeaderSlots | null;
}

export const WorkstationTabHeaderSlotsView: React.FC<WorkstationTabHeaderSlotsViewProps> =
  memo(({ slots }) => {
    return (
      <div className="flex min-w-0 flex-1 items-center">
        {slots?.leading && (
          <NoDragRegion className="flex shrink-0 items-center">
            {slots.leading}
          </NoDragRegion>
        )}
        <NoDragRegion className="flex min-w-0 flex-1 items-center">
          {slots?.content}
        </NoDragRegion>
        {slots?.trailing && (
          <NoDragRegion className="flex shrink-0 items-center gap-px">
            {slots.trailing}
          </NoDragRegion>
        )}
      </div>
    );
  });

WorkstationTabHeaderSlotsView.displayName = "WorkstationTabHeaderSlotsView";
