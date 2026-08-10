import React from "react";

import type { JourneyScope } from "@src/api/tauri/journeyGraph";

import { JourneyContainer } from "./JourneyContainer";
import { SessionJourneySnapshot } from "./SessionJourneySnapshot";

export const SessionJourneyPage: React.FC<{
  sessionId: string;
  sessionName?: string;
  selectedTaskId?: string;
  selectedForkId?: string;
  selectedAnchorMessageId?: string;
}> = ({
  sessionId,
  sessionName,
  selectedTaskId,
  selectedForkId,
  selectedAnchorMessageId,
}) => (
  <div className="flex h-full min-h-0 flex-col">
    <SessionJourneySnapshot
      sessionId={sessionId}
      selectedTaskId={selectedTaskId}
      selectedForkId={selectedForkId}
      selectedAnchorMessageId={selectedAnchorMessageId}
    />
    <div className="min-h-0 flex-1">
      <JourneyContainer
        scope={`session/${sessionId}` as JourneyScope}
        title={`会话旅程${sessionName ? ` · ${sessionName}` : ""}`}
      />
    </div>
  </div>
);
