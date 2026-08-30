import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { FileSymlinkIcon, HugeiconsIcon } from "@src/icons";
import { openFileInEditor } from "@src/util/ui/openFileInEditor";

import type { ToolSourceTarget } from "./helpers/toolSource";

const ICON_BUTTON_CLASSES =
  "flex h-6 w-6 items-center justify-center rounded text-text-3 " +
  "transition-colors hover:bg-fill-3 hover:text-text-1";

export interface ToolResultActionsProps {
  source: ToolSourceTarget | null;
}

const ToolResultActions: React.FC<ToolResultActionsProps> = ({ source }) => {
  const { t } = useTranslation("sessions");

  const handleOpenSource = useCallback(() => {
    if (!source) return;
    openFileInEditor(source.path, { line: source.line });
  }, [source]);

  if (!source) return null;

  return (
    <button
      type="button"
      className={ICON_BUTTON_CLASSES}
      onClick={(event) => {
        event.stopPropagation();
        handleOpenSource();
      }}
      title={t("tools.openSource")}
      aria-label={t("tools.openSource")}
    >
      <HugeiconsIcon
        icon={FileSymlinkIcon}
        data-icon="file-symlink"
        size={13}
      />
    </button>
  );
};

ToolResultActions.displayName = "ToolResultActions";

export default ToolResultActions;
