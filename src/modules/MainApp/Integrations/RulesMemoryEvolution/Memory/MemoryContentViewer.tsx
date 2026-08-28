/**
 * MemoryContentViewer
 *
 * Read-only / editable view of a single workspace memory file.
 * Shows the markdown content, a copy button, and an edit button
 * that opens a full-screen modal with an inline MarkdownEditor.
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { WorkspaceMemoryDetail } from "@src/api/tauri/rpc/schemas/workspaceMemory";
import Button from "@src/components/Button";
import Markdown from "@src/components/MarkDown";
import Message from "@src/components/Message";
import { Copy01Icon, HugeiconsIcon, Pen01Icon } from "@src/icons";
import MarkdownEditor from "@src/modules/shared/components/MarkdownEditor";
import Modal from "@src/scaffold/ModalSystem";
import { copyText } from "@src/util/data/clipboard";

export interface MemoryContentViewerProps {
  detail: WorkspaceMemoryDetail;
  workspace: string;
  onSaved: () => void;
}

const MemoryContentViewer = ({
  detail,
  workspace,
  onSaved,
}: MemoryContentViewerProps) => {
  const { t } = useTranslation("settings");
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [draftContent, setDraftContent] = useState(detail.content);
  const [saving, setSaving] = useState(false);

  const handleSave = useCallback(() => {
    if (!draftContent.trim()) return;
    setSaving(true);
    rpc.workspaceMemory
      .write({ workspace, filename: detail.filename, content: draftContent })
      .then(() => {
        setEditModalOpen(false);
        onSaved();
        Message.success(t("common:actions.saved"));
      })
      .catch(() => {
        Message.error(t("indexing.workspaceMemorySaveFailed"));
      })
      .finally(() => setSaving(false));
  }, [workspace, detail.filename, draftContent, onSaved, t]);

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      {detail.freshnessCaveat && (
        <p className="text-xs text-warning-6">{detail.freshnessCaveat}</p>
      )}
      <div className="group/detail relative">
        <div className="policy-markdown-scroll max-h-[360px] w-full min-w-0 max-w-full select-text overflow-auto">
          <Markdown textContent={detail.content || "(empty)"} skipPreprocess />
        </div>
        <div className="absolute right-2 top-2 flex gap-1 opacity-0 transition-opacity group-hover/detail:opacity-100">
          <Button
            onClick={() => {
              copyText(detail.content)
                .then(() => {
                  Message.success(t("storage.copiedPath"));
                })
                .catch(() => {
                  Message.error(t("common:status.copyFailed"));
                });
            }}
            icon={
              <HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={11} />
            }
            iconOnly
            title={t("common:actions.copy")}
          />
          <Button
            onClick={() => setEditModalOpen(true)}
            icon={
              <HugeiconsIcon icon={Pen01Icon} data-icon="pencil" size={11} />
            }
            iconOnly
            title={t("common:actions.edit")}
          />
        </div>
      </div>
      <Modal
        visible={editModalOpen}
        title={detail.filename}
        onCancel={() => {
          setEditModalOpen(false);
          setDraftContent(detail.content);
        }}
        onOk={handleSave}
        okText={t("common:actions.save")}
        cancelText={t("common:actions.cancel")}
        okButtonProps={{
          disabled: saving || !draftContent.trim(),
          loading: saving,
        }}
        width="min(960px, 92vw)"
        maskClosable={false}
      >
        <MarkdownEditor
          value={draftContent}
          onChange={setDraftContent}
          minHeight={420}
          maxHeight={520}
          showTokenCount={false}
          defaultTab="edit"
        />
      </Modal>
    </div>
  );
};

export default MemoryContentViewer;
