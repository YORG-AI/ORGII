/** Paste-a-share-link entry point: parsed token goes to `org2CloudPendingShareAtom`; `CloudShareImportDialog` owns the resolve → import flow (anon-capable). */
import Modal from "@/src/scaffold/ModalSystem";
import { useSetAtom } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";

import { parseCloudShareInput } from "./org2CloudOrgManagement";
import { org2CloudPendingShareAtom } from "./org2CloudPendingShareAtom";

interface ImportSharedSessionDialogProps {
  visible: boolean;
  onClose: () => void;
}

const ImportSharedSessionDialog: React.FC<ImportSharedSessionDialogProps> = ({
  visible,
  onClose,
}) => {
  const { t } = useTranslation("navigation");
  const setPendingShare = useSetAtom(org2CloudPendingShareAtom);
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);

  const handleClose = useCallback(() => {
    setValue("");
    setInvalid(false);
    onClose();
  }, [onClose]);

  const handlePasteFromClipboard = useCallback(() => {
    navigator.clipboard
      .readText()
      .then((text) => {
        if (!text) return;
        setValue(text);
        setInvalid(false);
      })
      .catch(() => undefined);
  }, []);

  const handleSubmit = useCallback(() => {
    const parsed = parseCloudShareInput(value);
    if (!parsed) {
      setInvalid(true);
      return;
    }
    setPendingShare(parsed);
    handleClose();
  }, [handleClose, setPendingShare, value]);

  return (
    <Modal
      visible={visible}
      title={t("cloud.share.importDialogTitle")}
      onCancel={handleClose}
      footer={null}
      width={440}
    >
      <div className="flex flex-col gap-3" data-testid="import-session-dialog">
        <Input
          value={value}
          onChange={(next) => {
            setValue(next);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") handleSubmit();
          }}
          placeholder={t("cloud.share.importInputPlaceholder")}
          errorMessage={
            invalid ? t("cloud.share.importInvalidInput") : undefined
          }
          autoComplete="off"
          spellCheck={false}
          data-testid="import-session-input"
        />
        <div className="flex items-center justify-between gap-2">
          <Button
            htmlType="button"
            size="small"
            variant="secondary"
            onClick={handlePasteFromClipboard}
          >
            {t("cloud.share.importPasteClipboard")}
          </Button>
          <Button
            htmlType="button"
            variant="primary"
            disabled={!value.trim()}
            onClick={handleSubmit}
            data-testid="import-session-submit"
          >
            {t("cloud.share.importSubmit")}
          </Button>
        </div>
      </div>
    </Modal>
  );
};

export default ImportSharedSessionDialog;
