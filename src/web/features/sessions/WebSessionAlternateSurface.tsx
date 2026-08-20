import React, { memo } from "react";

import SessionRawTranscriptView from "@src/engines/ChatPanel/components/SessionRawTranscriptView";
import SessionChangesView from "@src/engines/ChatPanel/components/SessionViewSwitcher/SessionChangesView";
import SessionTimelineView from "@src/engines/ChatPanel/components/SessionViewSwitcher/SessionTimelineView";
import type { UseSessionViewModeResult } from "@src/engines/ChatPanel/hooks/useSessionViewMode";

import { useCloudSessionTurnIndex } from "./useCloudSessionTurnIndex";
import type { WebSessionListItem } from "./useWebSessionRoster";

export interface WebSessionAlternateSurfaceProps {
  session: WebSessionListItem;
  view: UseSessionViewModeResult;
  topInset?: number;
}

/** Cloud-backed alternate session views for the Web read-only surface. */
export const WebSessionAlternateSurface: React.FC<WebSessionAlternateSurfaceProps> =
  memo(({ session, view, topInset = 0 }) => {
    const { mode } = view;
    const needsTurnIndex = mode === "timeline" || mode === "changes";
    const turnIndex = useCloudSessionTurnIndex(session, needsTurnIndex);

    if (mode === "raw") {
      return (
        <SessionRawTranscriptView
          sessionId={session.sourceSessionId}
          transcript={view.transcript}
          topInset={topInset}
        />
      );
    }
    if (mode === "timeline") {
      return (
        <SessionTimelineView
          turns={turnIndex.turns}
          loading={turnIndex.loading}
          error={turnIndex.error}
          topInset={topInset}
        />
      );
    }
    if (mode === "changes") {
      return (
        <SessionChangesView
          turns={turnIndex.turns}
          loading={turnIndex.loading}
          error={turnIndex.error}
          topInset={topInset}
        />
      );
    }
    return null;
  });

WebSessionAlternateSurface.displayName = "WebSessionAlternateSurface";
