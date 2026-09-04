/**
 * UserEvent - Universal Component
 *
 * Renders user message events in the simulator context.
 *
 * In chat panels, user messages are routed via `isUser: true` on the ChatItem
 * and rendered by `UserChatItem` — they never reach this component.
 * This component only serves the simulator/replay variant.
 */
import React, { Suspense, lazy } from "react";

import {
  type RawEventInput,
  useNormalizedEventProps,
} from "@src/engines/SessionCore/rendering/props";
import type { EventVariant } from "@src/engines/SessionCore/rendering/types/universalProps";

const LazySimulatorMessages = lazy(
  () => import("@src/modules/WorkStation/Chat/Communication")
);

// ============================================
// Types
// ============================================

interface UserEventProps extends RawEventInput {
  variant?: EventVariant;
}

// ============================================
// Main Component
// ============================================

export const UserEvent: React.FC<UserEventProps> = (props) => {
  const normalizedProps = useNormalizedEventProps(props, "user");

  if (!normalizedProps) return null;

  return (
    <Suspense fallback={null}>
      <LazySimulatorMessages
        currentEvent={props}
        mode={(props.mode as "interactive" | "simulation") || "interactive"}
      />
    </Suspense>
  );
};

UserEvent.displayName = "UserEvent";

export default UserEvent;
