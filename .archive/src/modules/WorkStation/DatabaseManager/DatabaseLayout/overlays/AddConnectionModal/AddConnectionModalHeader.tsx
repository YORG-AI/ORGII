import { Server, X } from "lucide-react";
import { memo } from "react";
import { useTranslation } from "react-i18next";

import { HEADER_BUTTON } from "@src/modules/WorkStation/shared/tokens";

export interface AddConnectionModalHeaderProps {
  onClose: () => void;
}

export const AddConnectionModalHeader = memo(function AddConnectionModalHeader({
  onClose,
}: AddConnectionModalHeaderProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-between border-b border-border-1 px-4 py-3">
      <div className="flex items-center gap-2">
        <Server size={18} strokeWidth={1.75} className="text-primary-6" />
        <h3 className="text-sm font-medium text-text-1">
          {t("database.addConnection")}
        </h3>
      </div>
      <button
        type="button"
        onClick={onClose}
        className={HEADER_BUTTON.actionMd}
      >
        <X size={16} strokeWidth={1.75} />
      </button>
    </div>
  );
});
