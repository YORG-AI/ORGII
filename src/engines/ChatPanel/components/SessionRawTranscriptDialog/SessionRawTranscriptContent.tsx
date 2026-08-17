import React, { memo } from "react";
import { useTranslation } from "react-i18next";

import { CodeMirrorEditor } from "@src/features/CodeMirror/Editor";

export interface SessionRawTranscriptContentProps {
  error: string | null;
  filePath?: string;
  loaded: boolean;
  loading: boolean;
  transcriptJson: string;
}

const SessionRawTranscriptContent: React.FC<SessionRawTranscriptContentProps> =
  memo(({ error, filePath, loaded, loading, transcriptJson }) => {
    const { t } = useTranslation("common");

    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden [&_.codemirror-editor-wrapper]:h-full">
        {error ? (
          <div
            role="alert"
            className="rounded-md border border-danger-6/40 bg-danger-1 px-3 py-2 text-sm text-danger-6"
          >
            {error}
          </div>
        ) : null}
        <CodeMirrorEditor
          value={
            loading && !loaded
              ? t("status.loading", { defaultValue: "Loading…" })
              : transcriptJson
          }
          filePath={filePath}
          language="json"
          height="100%"
          readOnly
          enableLinting={false}
          enableDirtyDiff={false}
          registerWithService={false}
          enableGitBlame={false}
        />
      </div>
    );
  });

SessionRawTranscriptContent.displayName = "SessionRawTranscriptContent";

export default SessionRawTranscriptContent;
