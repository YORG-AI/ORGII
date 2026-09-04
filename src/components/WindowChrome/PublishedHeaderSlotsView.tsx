import type { ReactNode } from "react";
import React, { memo } from "react";

import { HEADER_CONTENT_LEFT_PADDING_CLASS } from "@src/config/workstation/tokens";

import { NoDragRegion } from "./NoDragRegion";

/** Shared slot shape for the 36px published header bars. */
export interface PublishedHeaderSlots {
  leading?: ReactNode;
  content?: ReactNode;
  trailing?: ReactNode;
  /** Visually joins this 36px header to a following pane-owned row. */
  joinWithFollowingRow?: boolean;
  /** The active split surface owns this chrome in its left column instead. */
  hidden?: boolean;
}

interface PublishedHeaderSlotsViewProps {
  slots: PublishedHeaderSlots | null;
  /** Left inset for host-specific chrome alignment. */
  paddingLeftClassName?: string;
}

/**
 * Renders pane-owned controls into a shell-owned header row. My Station,
 * Agent Station replay, and the chat pane share this exact slot layout.
 */
export const PublishedHeaderSlotsView: React.FC<PublishedHeaderSlotsViewProps> =
  memo(
    ({ slots, paddingLeftClassName = HEADER_CONTENT_LEFT_PADDING_CLASS }) => {
      return (
        <div
          className={`flex min-w-0 flex-1 items-center ${paddingLeftClassName}`}
        >
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
    }
  );

PublishedHeaderSlotsView.displayName = "PublishedHeaderSlotsView";
