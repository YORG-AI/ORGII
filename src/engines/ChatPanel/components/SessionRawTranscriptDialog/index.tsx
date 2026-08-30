import React, { Suspense, lazy, memo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { ClipboardIcon, HugeiconsIcon, Refresh04Icon } from "@src/icons";
import Modal from "@src/scaffold/ModalSystem";

import { useSessionRawTranscript } from "./useSessionRawTranscript";

// Lazy (same as SessionRawTranscriptView): the transcript content pulls
// CodeMirror, and this dialog is imported by the WorkStation TabBar — which
// every workstation surface renders — but only opens on demand.
const SessionRawTranscriptContent = lazy(
  () => import("./SessionRawTranscriptContent")
);

export interface SessionRawTranscriptDialogProps {
  sessionId: string | null;
  visible: boolean;
  onClose: () => void;
}

const SessionRawTranscriptDialog: React.FC<SessionRawTranscriptDialogProps> =
  memo(({ sessionId, visible, onClose }) => {
    const { t } = useTranslation("sessions");
    const transcript = useSessionRawTranscript(sessionId, visible);

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
              icon={
                <HugeiconsIcon
                  icon={Refresh04Icon}
                  data-icon="refresh-cw"
                  size={14}
                  strokeWidth={1.75}
                />
              }
              loading={transcript.loading}
              disabled={!sessionId}
              onClick={() => void transcript.loadTranscript()}
            >
              {t("common:actions.refresh", "Refresh")}
            </Button>
            <Button
              size="small"
              icon={
                <HugeiconsIcon
                  icon={ClipboardIcon}
                  data-icon="clipboard"
                  size={14}
                  strokeWidth={1.75}
                />
              }
              disabled={!transcript.snapshot || transcript.loading}
              onClick={() => void transcript.copyTranscript()}
            >
              {t("common:actions.copy", "Copy")}
            </Button>
            <Button size="small" variant="primary" onClick={onClose}>
              {t("common:actions.close", "Close")}
            </Button>
          </div>
        }
      >
        <div className="flex min-h-0 flex-1 flex-col gap-2 px-4 pb-4">
          <Suspense fallback={null}>
            <SessionRawTranscriptContent
              error={transcript.error}
              filePath={
                sessionId ? `raw-transcript-${sessionId}.json` : undefined
              }
              loaded={Boolean(transcript.snapshot)}
              loading={transcript.loading}
              transcriptJson={transcript.transcriptJson}
            />
          </Suspense>
        </div>
      </Modal>
    );
  });

SessionRawTranscriptDialog.displayName = "SessionRawTranscriptDialog";

export default SessionRawTranscriptDialog;
