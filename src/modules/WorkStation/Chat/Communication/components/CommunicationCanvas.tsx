import { Suspense, lazy } from "react";

import EventWrapper from "@src/engines/ChatPanel/adapters/EventWrapper";
import type { SimulatorAppBaseState } from "@src/engines/Simulator/apps/core/types";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import type { BackendEvent } from "@src/types/session/steps";

const LazySimulatorCanvas = lazy(
  () => import("@src/modules/WorkStation/Canvas")
);

interface CommunicationCanvasProps {
  currentEvent: unknown;
  mode: "interactive" | "simulation";
}

const noopSelectItem = (_itemId: string) => {};

export function CommunicationCanvas({
  currentEvent,
  mode,
}: CommunicationCanvasProps) {
  return (
    <EventWrapper
      event={currentEvent as BackendEvent}
      mode={mode}
      expand
      padding="p-0"
    >
      <Suspense
        fallback={
          <Placeholder
            variant="loading"
            placement="detail-panel"
            fillParentHeight
            title="Loading…"
          />
        }
      >
        <LazySimulatorCanvas
          state={{} as SimulatorAppBaseState}
          selectedItemId={null}
          onSelectItem={noopSelectItem}
          currentEvent={currentEvent}
          mode={mode}
        />
      </Suspense>
    </EventWrapper>
  );
}
