import React from "react";

import type { JourneyScope } from "@src/api/tauri/journeyGraph";

import { JourneyContainer } from "./JourneyContainer";
import { SessionJourneySnapshot } from "./SessionJourneySnapshot";

export const SessionJourneyPage: React.FC<{
  sessionId: string;
  sessionName?: string;
}> = ({ sessionId, sessionName }) => (
  <div className="flex h-full min-h-0 flex-col">
    <SessionJourneySnapshot sessionId={sessionId} />
    <div className="min-h-0 flex-1">
      <JourneyContainer
        scope={`session/${sessionId}` as JourneyScope}
        title={`Session Journey${sessionName ? ` · ${sessionName}` : ""}`}
      />
    </div>
  </div>
);
