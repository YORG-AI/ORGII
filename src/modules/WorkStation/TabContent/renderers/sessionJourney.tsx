/** Renderer for read-only `session-journey` tabs. */
import React, { memo } from "react";

import { SessionJourneyPage } from "@src/modules/ProjectManager/JourneyGraph";

import type { UnifiedTabContentProps } from "../types";

const SessionJourneyTabRenderer: React.FC<UnifiedTabContentProps> = memo(({ tab }) => {
  const sessionId = tab.data.sessionId as string | undefined;
  if (!sessionId) return <div className="p-3 text-xs text-warning-6" role="alert">Journey unavailable: Session identity is required; refusing to guess a Journey graph.</div>;
  return <SessionJourneyPage sessionId={sessionId} sessionName={tab.data.sessionName as string | undefined} />;
});

SessionJourneyTabRenderer.displayName = "SessionJourneyTabRenderer";
export default SessionJourneyTabRenderer;
