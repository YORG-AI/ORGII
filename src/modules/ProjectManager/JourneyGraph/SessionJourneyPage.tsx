import React from "react";

import type { JourneyScope } from "@src/api/tauri/journeyGraph";

import { JourneyContainer } from "./JourneyContainer";

export const SessionJourneyPage: React.FC<{ sessionId: string; sessionName?: string }> = ({ sessionId, sessionName }) => (
  <JourneyContainer scope={`session/${sessionId}` as JourneyScope} title={`Session Journey${sessionName ? ` · ${sessionName}` : ""}`} />
);
