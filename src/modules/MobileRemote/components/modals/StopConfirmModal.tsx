import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import BottomSheet from "@src/components/BottomSheet";
import Button from "@src/components/Button";

export interface StopConfirmModalProps {
  visible: boolean;
  onCancel?: () => void;
  onConfirm?: () => void;
  confirming?: boolean;
}

/** M-15 Stop Confirm Modal — confirms cancel before session/cancel. */
export function StopConfirmModal({
  visible,
  onCancel,
  onConfirm,
  confirming = false,
}: StopConfirmModalProps) {
  const { t } = useTranslation("mobileRemote");

  const handleCancel = useCallback(() => {
    onCancel?.();
  }, [onCancel]);

  const handleConfirm = useCallback(() => {
    onConfirm?.();
  }, [onConfirm]);

  return (
    <BottomSheet
      open={visible}
      title={t("stopConfirm.title")}
      dismissible={!confirming}
      onClose={handleCancel}
      bodyClassName="px-5 py-4"
      footer={
        <div className="flex items-center justify-end gap-2 px-4 py-3">
          <Button
            variant="tertiary"
            onClick={handleCancel}
            disabled={confirming}
          >
            {t("stopConfirm.cancel")}
          </Button>
          <Button
            variant="primary"
            onClick={handleConfirm}
            loading={confirming}
            data-modal-primary-action
            className="!bg-danger-6 hover:!bg-danger-5"
          >
            {t("stopConfirm.confirm")}
          </Button>
        </div>
      }
    >
      <div className="text-[13px] leading-5 text-text-3">
        {t("stopConfirm.body")}
      </div>
    </BottomSheet>
  );
}

StopConfirmModal.displayName = "StopConfirmModal";
