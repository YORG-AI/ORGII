import {
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Message from "@src/components/Message";
import { createLogger } from "@src/hooks/logger";
import { FileCodeIcon, FolderInputIcon, HugeiconsIcon } from "@src/icons";
import Modal from "@src/scaffold/ModalSystem";
import type { Session } from "@src/store/session";

import {
  SESSION_JSON_FILTER,
  type SessionExportDraft,
  type SessionExportPreview,
  type SessionImportPreview,
  buildSessionExportDraft,
  formatCategoryLabel,
  formatEventCount,
  importSessionExportFile,
  parseSessionImportFile,
  stringifySessionExportFile,
} from "./sessionImportExport";

const logger = createLogger("SessionImportExportModal");

type Mode = "export" | "import";

interface PendingImport {
  preview: SessionImportPreview;
  parsed: Parameters<typeof importSessionExportFile>[0];
}

interface SessionImportExportModalProps {
  visible: boolean;
  mode: Mode;
  activeSession?: Session;
  sessionFallbackName: string;
  onClose: () => void;
  onImported: (sessionId: string, sessionName: string) => void;
}

function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-lg bg-bg-2 px-3 py-2">
      <span className="shrink-0 whitespace-nowrap text-xs text-text-3">
        {label}
      </span>
      <span className="min-w-0 truncate text-right text-sm text-text-1">
        {value}
      </span>
    </div>
  );
}

export function SessionImportExportModal({
  visible,
  mode,
  activeSession,
  sessionFallbackName,
  onClose,
  onImported,
}: SessionImportExportModalProps) {
  const { t } = useTranslation("sessions");
  const [exportDraft, setExportDraft] = useState<SessionExportDraft | null>(
    null
  );
  const [pendingImport, setPendingImport] = useState<PendingImport | null>(
    null
  );
  const [loading, setLoading] = useState(false);
  const exportPreview: SessionExportPreview | null =
    exportDraft?.preview ?? null;

  React.useEffect(() => {
    if (!visible) {
      setExportDraft(null);
      setPendingImport(null);
      setLoading(false);
      return;
    }
    if (mode !== "export" || !activeSession) return;

    let cancelled = false;
    setLoading(true);
    buildSessionExportDraft(activeSession, sessionFallbackName)
      .then((draft) => {
        if (!cancelled) setExportDraft(draft);
      })
      .catch((error: unknown) => {
        logger.error("failed to build export preview:", error);
        if (!cancelled)
          Message.error(t("chat.importExport.errors.previewFailed"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeSession, mode, sessionFallbackName, t, visible]);

  const title = useMemo(() => {
    return mode === "export"
      ? t("chat.importExport.exportTitle")
      : t("chat.importExport.importTitle");
  }, [mode, t]);

  const handleChooseImportFile = useCallback(async () => {
    setLoading(true);
    try {
      const filePath = await openDialog({
        multiple: false,
        filters: [SESSION_JSON_FILTER],
      });
      if (!filePath || Array.isArray(filePath)) return;
      const raw = await readTextFile(filePath);
      const { parsed, preview } = parseSessionImportFile(raw, t);
      setPendingImport({ parsed, preview });
    } catch (error) {
      logger.error("failed to read import file:", error);
      Message.error(t("chat.importExport.errors.importReadFailed"));
    } finally {
      setLoading(false);
    }
  }, [t]);

  const handleConfirmExport = useCallback(async () => {
    if (!exportDraft) return;
    try {
      const filePath = await saveDialog({
        defaultPath: exportDraft.preview.fileName,
        filters: [SESSION_JSON_FILTER],
      });
      if (!filePath) return;
      setLoading(true);
      await writeTextFile(
        filePath,
        stringifySessionExportFile(exportDraft.file)
      );
      Message.success(t("chat.importExport.exportSuccess"));
      onClose();
    } catch (error) {
      logger.error("failed to export session:", error);
      Message.error(t("chat.importExport.errors.exportFailed"));
    } finally {
      setLoading(false);
    }
  }, [exportDraft, onClose, t]);

  const handleConfirmImport = useCallback(async () => {
    if (!pendingImport) return;
    setLoading(true);
    try {
      const result = await importSessionExportFile(
        pendingImport.parsed,
        pendingImport.preview
      );
      Message.success(
        t("chat.importExport.importSuccess", {
          count: result.importedEventCount,
        })
      );
      onImported(result.importSessionId, result.importedName);
      onClose();
    } catch (error) {
      logger.error("failed to import session:", error);
      Message.error(t("chat.importExport.errors.importFailed"));
    } finally {
      setLoading(false);
    }
  }, [onClose, onImported, pendingImport, t]);

  const handleOk = useCallback(async () => {
    if (mode === "export") {
      await handleConfirmExport();
      return;
    }
    if (pendingImport) {
      await handleConfirmImport();
      return;
    }
    await handleChooseImportFile();
  }, [
    handleChooseImportFile,
    handleConfirmExport,
    handleConfirmImport,
    mode,
    pendingImport,
  ]);

  const okText =
    mode === "export"
      ? t("chat.importExport.exportAction")
      : pendingImport
        ? t("chat.importExport.importAction")
        : t("chat.importExport.chooseJson");
  const okDisabled = mode === "export" && (!activeSession || !exportPreview);

  return (
    <Modal
      visible={visible}
      title={title}
      onCancel={onClose}
      onOk={handleOk}
      okText={okText}
      cancelText={t("common:actions.cancel")}
      okButtonProps={{ loading, disabled: okDisabled }}
      cancelButtonProps={{ disabled: loading }}
      width={mode === "export" ? 640 : 440}
      maskClosable={!loading}
      escToExit={!loading}
    >
      <div className="flex flex-col gap-4 p-1">
        {mode === "import" && (
          <div className="flex items-start gap-3 rounded-xl border border-border-1 bg-bg-1 p-4">
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-bg-3 text-text-2">
              <HugeiconsIcon
                icon={FolderInputIcon}
                data-icon="folder-input"
                size={18}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-text-1">
                {t("chat.importExport.importDescription")}
              </div>
              <div className="mt-1 text-xs leading-5 text-text-3">
                {t("chat.importExport.jsonSnapshotNote")}
              </div>
            </div>
          </div>
        )}

        {mode === "export" && exportPreview && (
          <div className="flex flex-col gap-2">
            <InfoRow
              label={t("chat.importExport.fields.session")}
              value={exportPreview.displayName}
            />
            <InfoRow
              label={t("chat.importExport.fields.type")}
              value={formatCategoryLabel(exportPreview.category, t)}
            />
            <InfoRow
              label={t("chat.importExport.fields.events")}
              value={formatEventCount(exportPreview.eventCount, t)}
            />
            <InfoRow
              label={t("chat.importExport.fields.file")}
              value={exportPreview.fileName}
            />
          </div>
        )}

        {mode === "export" && !exportPreview && (
          <div className="rounded-lg bg-bg-2 px-3 py-4 text-center text-sm text-text-3">
            {loading
              ? t("chat.importExport.loadingPreview")
              : t("chat.importExport.noActiveSession")}
          </div>
        )}

        {mode === "import" && !pendingImport && (
          <button
            type="button"
            className="flex w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-border-2 bg-bg-1 px-4 py-8 text-center transition-colors hover:bg-bg-2"
            onClick={handleChooseImportFile}
            disabled={loading}
          >
            <HugeiconsIcon
              icon={FileCodeIcon}
              data-icon="file-json"
              size={28}
              className="text-text-2"
            />
            <span className="text-sm font-medium text-text-1">
              {t("chat.importExport.chooseJson")}
            </span>
            <span className="text-xs text-text-3">
              {t("chat.importExport.chooseJsonHint")}
            </span>
          </button>
        )}

        {mode === "import" && pendingImport && (
          <div className="flex flex-col gap-2">
            <InfoRow
              label={t("chat.importExport.fields.session")}
              value={pendingImport.preview.displayName}
            />
            <InfoRow
              label={t("chat.importExport.fields.type")}
              value={formatCategoryLabel(
                pendingImport.preview.originalCategory,
                t
              )}
            />
            <InfoRow
              label={t("chat.importExport.fields.events")}
              value={formatEventCount(pendingImport.preview.eventCount, t)}
            />
            <InfoRow
              label={t("chat.importExport.fields.importAs")}
              value={pendingImport.preview.importedName}
            />
          </div>
        )}
      </div>
    </Modal>
  );
}
