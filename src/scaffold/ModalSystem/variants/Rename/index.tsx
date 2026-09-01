/**
 * RenameModal Component
 *
 * A simple modal dialog for renaming items (sessions, etc.)
 * Uses custom Modal and Input components for consistent styling.
 */
import Modal from "@/src/scaffold/ModalSystem";
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";

interface RenameModalProps {
  /** Whether the modal is visible */
  visible: boolean;
  /** Current name to pre-fill */
  currentName: string;
  /** Title of the modal */
  title?: string;
  /** Placeholder text for input */
  placeholder?: string;
  /** Loading state during rename */
  loading?: boolean;
  /** Called when modal is closed/cancelled */
  onCancel: () => void;
  /** Called when rename is confirmed with the new name */
  onConfirm: (newName: string) => void;
}

const RenameModal: React.FC<RenameModalProps> = ({
  visible,
  currentName,
  title,
  placeholder,
  loading = false,
  onCancel,
  onConfirm,
}) => {
  const { t } = useTranslation("common");
  const [name, setName] = useState(currentName);

  // Reset name when modal opens with new currentName - defer to avoid synchronous setState in effect
  useEffect(() => {
    if (visible) {
      Promise.resolve().then(() => {
        setName(currentName);
      });
    }
  }, [visible, currentName]);

  const handleConfirm = useCallback(() => {
    const trimmedName = name.trim();
    if (trimmedName && trimmedName !== currentName) {
      onConfirm(trimmedName);
    } else if (!trimmedName) {
      // If empty, just close
      onCancel();
    } else {
      // Name unchanged, just close
      onCancel();
    }
  }, [name, currentName, onConfirm, onCancel]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === "Enter" && !loading) {
        handleConfirm();
      }
    },
    [handleConfirm, loading]
  );

  return (
    <Modal
      visible={visible}
      title={title ?? t("actions.rename")}
      onCancel={onCancel}
      onOk={handleConfirm}
      okText={t("actions.rename")}
      cancelText={t("actions.cancel")}
      okButtonProps={{
        loading,
        disabled: !name.trim() || name.trim() === currentName,
      }}
      style={{ maxWidth: 400 }}
      className="rename-modal"
    >
      <div className="p-2">
        <Input
          value={name}
          onChange={setName}
          onKeyDown={handleKeyDown}
          placeholder={placeholder ?? t("labels.name")}
          autoFocus
          maxLength={255}
          showWordLimit
        />
      </div>
    </Modal>
  );
};

export default RenameModal;
