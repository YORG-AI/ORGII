import React, { Suspense, lazy, memo } from "react";

import type { useSessionRawTranscript } from "@src/engines/ChatPanel/components/SessionRawTranscriptDialog/useSessionRawTranscript";

// Lazy: the transcript content pulls CodeMirror, and this view only mounts
// when the user switches a session to the Raw alternate view.
const SessionRawTranscriptContent = lazy(
  () =>
    import("@src/engines/ChatPanel/components/SessionRawTranscriptDialog/SessionRawTranscriptContent")
);

interface SessionRawTranscriptViewProps {
  sessionId: string;
  transcript: ReturnType<typeof useSessionRawTranscript>;
  /** Space reserved for host chrome that overlays the view. */
  topInset?: number;
}

const SessionRawTranscriptView: React.FC<SessionRawTranscriptViewProps> = memo(
  ({ sessionId, transcript, topInset = 0 }) => {
    return (
      <div
        data-testid="workstation-session-raw-view"
        className="flex min-h-0 flex-1 flex-col"
        style={topInset > 0 ? { paddingTop: topInset } : undefined}
      >
        <Suspense fallback={null}>
          <SessionRawTranscriptContent
            error={transcript.error}
            filePath={`raw-transcript-${sessionId}.json`}
            loaded={Boolean(transcript.snapshot)}
            loading={transcript.loading}
            transcriptJson={transcript.transcriptJson}
          />
        </Suspense>
      </div>
    );
  }
);

SessionRawTranscriptView.displayName = "SessionRawTranscriptView";

export default SessionRawTranscriptView;
