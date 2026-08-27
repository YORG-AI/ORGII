/**
 * CanvasIframe — keyed wrapper around CanvasDesignSurface.
 *
 * Owns the remount key so a reload or a different event re-renders the
 * artifact from scratch, while design mode toggles in place.
 */
import React from "react";

import type { CanvasPayload } from "./canvasPayload";
import CanvasDesignSurface from "./design/CanvasDesignSurface";

interface CanvasIframeProps {
  payload: CanvasPayload;
  reloadKey: number;
  title: string;
  eventId: string;
  sessionId: string;
  designEnabled: boolean;
}

const CanvasIframe: React.FC<CanvasIframeProps> = ({
  payload,
  reloadKey,
  title,
  eventId,
  sessionId,
  designEnabled,
}) => {
  return (
    <CanvasDesignSurface
      // `designEnabled` is deliberately not part of the key: the inspector
      // effect handles enable/disable without remounting, and a remount would
      // reset the rendered artifact's state on every design toggle.
      key={`${eventId}:${reloadKey}`}
      payload={payload}
      reloadKey={reloadKey}
      title={title}
      eventId={eventId}
      sessionId={sessionId}
      designEnabled={designEnabled}
    />
  );
};

CanvasIframe.displayName = "CanvasIframe";
export default CanvasIframe;
