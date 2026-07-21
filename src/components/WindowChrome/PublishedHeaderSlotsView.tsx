import type { ReactNode } from "react";
import React, { memo } from "react";

import { NoDragRegion } from "./NoDragRegion";

/** Shared slot shape for the 40px published header bars. */
export interface PublishedHeaderSlots {
  leading?: ReactNode;
  content?: ReactNode;
  trailing?: ReactNode;
  /** Visually joins this 40px header to a following pane-owned row. */
  joinWithFollowingRow?: boolean;
}

interface PublishedHeaderSlotsViewProps {
  slots: PublishedHeaderSlots | null;
}

/**
 * Renders pane-owned controls into a shell-owned header row. My Station,
 * Agent Station replay, and the chat pane share this exact slot layout.
 */
export const PublishedHeaderSlotsView: React.FC<PublishedHeaderSlotsViewProps> =
  memo(({ slots }) => {
    return (
      <div className="flex min-w-0 flex-1 items-center pl-2">
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

PublishedHeaderSlotsView.displayName = "PublishedHeaderSlotsView";
