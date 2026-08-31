import { useAtomValue } from "jotai";
import { useCallback, useEffect } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Modal from "@src/scaffold/ModalSystem";
import { quitConfirmationModalOpenAtom } from "@src/store/ui/overlayAtom";
import { getInstrumentedStore } from "@src/util/core/state/instrumentedStore";

async function invokeQuitCommand() {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("confirm_quit_app");
}

async function invokeCancelQuitCommand() {
  const { invoke } = await import("@tauri-apps/api/core");
  await invoke("cancel_quit_confirmation");
}

const QuitConfirmationModal = () => {
  const isOpen = useAtomValue(quitConfirmationModalOpenAtom);
  const { t } = useTranslation("common");

  const handleCancel = useCallback(() => {
    getInstrumentedStore().set(quitConfirmationModalOpenAtom, false);
    void invokeCancelQuitCommand();
  }, []);

  const handleQuit = useCallback(() => {
    getInstrumentedStore().set(quitConfirmationModalOpenAtom, false);
    void invokeQuitCommand();
  }, []);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing) return;

      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        handleCancel();
        return;
      }

      if (event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        handleQuit();
      }
    };

    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [handleCancel, handleQuit, isOpen]);

  return (
    <Modal
      visible={isOpen}
      title={t("quitConfirmation.title")}
      width={360}
      closable={false}
      maskClosable={false}
      onCancel={handleCancel}
      bodyClassName="px-5 py-3"
      footerTopBorder={false}
      footer={
        <div className="flex h-12 items-center justify-end gap-2 px-3">
          <Button variant="tertiary" onClick={handleCancel}>
            {t("quitConfirmation.cancel")}
          </Button>
          <Button
            variant="secondary"
            onClick={handleQuit}
            data-modal-primary-action
          >
            {t("quitConfirmation.confirm")}
          </Button>
        </div>
      }
    >
      <div className="text-[13px] leading-5 text-text-3">
        {t("quitConfirmation.subtitle")}
      </div>
    </Modal>
  );
};

export default QuitConfirmationModal;
