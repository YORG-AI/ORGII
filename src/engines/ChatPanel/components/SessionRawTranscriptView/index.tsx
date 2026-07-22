import React, { memo } from "react";

import SessionRawTranscriptContent from "@src/engines/ChatPanel/components/SessionRawTranscriptDialog/SessionRawTranscriptContent";
import type { useSessionRawTranscript } from "@src/engines/ChatPanel/components/SessionRawTranscriptDialog/useSessionRawTranscript";

export interface SessionRawTranscriptViewProps {
  sessionId: string;
  transcript: ReturnType<typeof useSessionRawTranscript>;
}

const SessionRawTranscriptView: React.FC<SessionRawTranscriptViewProps> = memo(
  ({ sessionId, transcript }) => {
    return (
      <div
        data-testid="workstation-session-raw-view"
        className="flex min-h-0 flex-1 flex-col"
      >
        <SessionRawTranscriptContent
          entries={transcript.entries}
          error={transcript.error}
          filePath={`raw-transcript-${sessionId}.json`}
          loading={transcript.loading}
          loadingOlder={transcript.loadingOlder}
          onLoadOlder={() => void transcript.loadOlder()}
          snapshot={transcript.snapshot}
          transcriptJson={transcript.transcriptJson}
        />
      </div>
    );
  }
);

SessionRawTranscriptView.displayName = "SessionRawTranscriptView";

export default SessionRawTranscriptView;
