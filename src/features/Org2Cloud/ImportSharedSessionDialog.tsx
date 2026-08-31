/** Paste-a-share-link entry point: the parsed link is queued as a unique attempt; `CloudShareImportDialog` owns the registered-user resolve → import flow. */
import Modal from "@/src/scaffold/ModalSystem";
import { useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Textarea from "@src/components/Textarea";

import { parseCloudShareInput } from "./org2CloudOrgManagement";
import { queueOrg2CloudPendingShareAtom } from "./org2CloudPendingShareAtom";

interface ImportSharedSessionDialogProps {
  visible: boolean;
  onClose: () => void;
}

const ImportSharedSessionDialog: React.FC<ImportSharedSessionDialogProps> = ({
  visible,
  onClose,
}) => {
  const { t } = useTranslation(["navigation", "common"]);
  const queuePendingShare = useSetAtom(queueOrg2CloudPendingShareAtom);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  const handleClose = useCallback(() => {
    setValue("");
    setInvalid(false);
    onClose();
  }, [onClose]);

  const handleSubmit = useCallback(() => {
    const parsed = parseCloudShareInput(value);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    queuePendingShare(parsed);
    handleClose();
  }, [handleClose, queuePendingShare, value]);

  return (
    <Modal
      visible={visible}
      title={t("cloud.share.importDialogTitle")}
      onCancel={handleClose}
      onOk={handleSubmit}
      okText={t("cloud.share.importSubmit")}
      cancelText={t("common:actions.cancel")}
      okButtonProps={{ disabled: !value.trim() }}
      size="large"
    >
      <div className="flex flex-col gap-2" data-testid="import-session-dialog">
        <Textarea
          value={value}
          onChange={(next) => {
            setValue(next);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          placeholder={t("cloud.share.importInputPlaceholder")}
          error={invalid}
          aria-invalid={invalid}
          aria-describedby={invalid ? "import-session-input-error" : undefined}
          autoComplete="off"
          spellCheck={false}
          rows={6}
          resize="vertical"
          size="large"
          data-testid="import-session-input"
        />
        {invalid && (
          <div
            id="import-session-input-error"
            role="alert"
            className="text-xs text-danger-6"
          >
            {t("cloud.share.importInvalidInput")}
          </div>
        )}
      </div>
    </Modal>
  );
};

export default ImportSharedSessionDialog;
