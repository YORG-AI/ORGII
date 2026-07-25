import { Clipboard, FileDown, RefreshCw } from "lucide-react";
import React, { memo, useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Modal from "@src/scaffold/ModalSystem";

import SessionRawTranscriptContent from "./SessionRawTranscriptContent";
import { useSessionRawTranscript } from "./useSessionRawTranscript";

export interface SessionRawTranscriptDialogProps {
  sessionId: string | null;
  visible: boolean;
  onClose: () => void;
}

const SessionRawTranscriptDialog: React.FC<SessionRawTranscriptDialogProps> =
  memo(({ sessionId, visible, onClose }) => {
    const { t } = useTranslation("sessions");
    const transcript = useSessionRawTranscript(sessionId, visible);
    const [exporting, setExporting] = useState(false);
    const isExternal = transcript.snapshot?.source.kind === "external-history";

    const handleExportAll = useCallback(async () => {
      if (!sessionId || !isExternal) return;
      setExporting(true);
      try {
        const result = await transcript.exportTranscript();
        if (!result) return;
        Message.success(
          t("chat.rawTranscript.exportSuccess", {
            defaultValue: "Raw transcript exported",
          })
        );
      } catch {
        Message.error(
          t("chat.rawTranscript.exportFailed", {
            defaultValue: "Could not export the raw transcript",
          })
        );
      } finally {
        setExporting(false);
      }
    }, [isExternal, sessionId, t, transcript]);

    return (
      <Modal
        visible={visible}
        title={t("chat.rawTranscript.title", {
          defaultValue: "Raw session transcript",
        })}
        onClose={onClose}
        width="min(960px, 92vw)"
        bodyClassName="flex min-h-0 flex-col p-0"
        style={{ height: "min(760px, 84vh)" }}
        footer={
          <div className="flex items-center justify-end gap-2 px-4 py-3">
            <Button
              size="small"
              icon={<RefreshCw size={14} strokeWidth={1.75} />}
              loading={transcript.loading}
              disabled={!sessionId}
              onClick={() => void transcript.loadTranscript()}
            >
              {t("common:actions.refresh", "Refresh")}
            </Button>
            <Button
              size="small"
              icon={<Clipboard size={14} strokeWidth={1.75} />}
              disabled={
                !transcript.snapshot ||
                transcript.loading ||
                !transcript.canCopyAll
              }
              title={
                transcript.canCopyAll
                  ? undefined
                  : t("chat.rawTranscript.copyTooLarge", {
                      defaultValue: "Use Export All for large transcripts",
                    })
              }
              onClick={() => void transcript.copyTranscript()}
            >
              {t("common:actions.copy", "Copy")}
            </Button>
            {isExternal ? (
              <Button
                size="small"
                icon={<FileDown size={14} strokeWidth={1.75} />}
                loading={exporting}
                disabled={!transcript.snapshot}
                onClick={() => void handleExportAll()}
              >
                {t("chat.rawTranscript.exportAll", {
                  defaultValue: "Export All",
                })}
              </Button>
            ) : null}
            <Button size="small" variant="primary" onClick={onClose}>
              {t("common:actions.close", "Close")}
            </Button>
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4">
          <SessionRawTranscriptContent
            entries={transcript.entries}
            error={transcript.error}
            filePath={
              sessionId ? `raw-transcript-${sessionId}.json` : undefined
            }
            loading={transcript.loading}
            loadingOlder={transcript.loadingOlder}
            onLoadOlder={() => void transcript.loadOlder()}
            snapshot={transcript.snapshot}
            transcriptJson={transcript.transcriptJson}
          />
        </div>
      </Modal>
    );
  });

SessionRawTranscriptDialog.displayName = "SessionRawTranscriptDialog";

export default SessionRawTranscriptDialog;
