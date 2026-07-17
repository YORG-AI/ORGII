/**
 * SimulatorContentArea Component
 *
 * Main content area for the simulator with header, wallpaper background.
 * Pairs with SimulatorTitleBar to create the complete simulator window experience.
 * Renders simulator content for the active app.
 *
 * Refactored structure:
 * - Main component: orchestration and prop management
 * - SimulatorSingleView: single view rendering
 * - useSimulatorContent: content rendering and caching
 * - StateDisplays: idle and booting state components
 */
import { type FC, memo } from "react";

import { useBackgroundImage } from "@src/hooks/theme/useBackgroundImage";
import useProgressiveImage from "@src/hooks/ui/effects/useProgressiveImage";

import { SimulatorSingleView } from "./components/SimulatorContentArea/SimulatorSingleView";
import { BootingState } from "./components/SimulatorContentArea/StateDisplays";
import type { SimulatorContentAreaProps } from "./components/SimulatorContentArea/types";
import { useSimulatorContent } from "./components/SimulatorContentArea/useSimulatorContent";

type RenderSignatureEvent =
  | (NonNullable<SimulatorContentAreaProps["currentEvent"]> & {
      lastActivityAt?: string;
    })
  | null
  | undefined;

function getEventRenderSignature(event: RenderSignatureEvent): string {
  if (!event) return "";
  return [
    event.id,
    event.chunk_id ?? "",
    event.functionName,
    event.displayStatus,
    event.displayText,
    event.displayVariant,
    event.lastActivityAt ?? "",
    event.args ? JSON.stringify(event.args) : "",
    event.result ? JSON.stringify(event.result) : "",
    event.extracted ? JSON.stringify(event.extracted) : "",
    event.payloadRefs ? JSON.stringify(event.payloadRefs) : "",
  ].join("|");
}

function getEventsTailSignature(
  events: SimulatorContentAreaProps["events"]
): string {
  if (!events || events.length === 0) return "0";
  const tail = events[events.length - 1];
  return `${events.length}:${getEventRenderSignature(tail)}`;
}

const SimulatorContentAreaComponent: FC<SimulatorContentAreaProps> = ({
  currentEvent = null,
  events = [],
  specs = [],
  onDockAppClick: _onDockAppClick,
  forceAppType = null,
  hideHeader = false,
  compactMode = false,
}) => {
  const wallpaperBg = useBackgroundImage();

  useProgressiveImage({
    src: wallpaperBg,
    autoLoad: true,
  });

  const { mainContentAppType, isBootingEvent, displayContent } =
    useSimulatorContent({
      currentEvent,
      events,
      specs,
      forceAppType,
    });

  return (
    <div
      className={`group relative flex h-full w-full flex-col overflow-hidden ${!hideHeader ? "rounded-xl" : ""} transition-all duration-300`}
    >
      {!isBootingEvent && (
        <SimulatorSingleView
          isBootingEvent={isBootingEvent}
          mainContentAppType={mainContentAppType}
          displayContent={displayContent}
          hideHeader={hideHeader}
          compactMode={compactMode}
        />
      )}

      {isBootingEvent && (
        <div
          className={`relative flex h-full w-full flex-col overflow-hidden ${!hideHeader ? "rounded-xl" : ""} bg-bg-2`}
        >
          <div className="min-h-0 flex-1 overflow-auto text-text-1">
            <BootingState />
          </div>
        </div>
      )}
    </div>
  );
};

/**
 * Custom comparison function to prevent unnecessary re-renders.
 * Only re-renders when:
 * - Event ID changes (not just object reference)
 * - Visual props change (agentColor)
 * - Index changes
 */
const arePropsEqual = (
  prev: SimulatorContentAreaProps,
  next: SimulatorContentAreaProps
): boolean => {
  if (prev.index !== next.index) return false;
  if (prev.agentColor !== next.agentColor) return false;
  if (prev.forceAppType !== next.forceAppType) return false;
  if (prev.hideHeader !== next.hideHeader) return false;
  if (prev.compactMode !== next.compactMode) return false;
  if (prev.events !== next.events) return false;
  if (prev.specs !== next.specs) return false;

  if (
    getEventRenderSignature(prev.currentEvent) !==
    getEventRenderSignature(next.currentEvent)
  ) {
    return false;
  }

  if (
    getEventsTailSignature(prev.events) !== getEventsTailSignature(next.events)
  ) {
    return false;
  }

  return true;
};

const SimulatorContentArea = memo(SimulatorContentAreaComponent, arePropsEqual);
SimulatorContentArea.displayName = "SimulatorContentArea";

export default SimulatorContentArea;
