import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { Delete02Icon, HugeiconsIcon } from "@src/icons";
import {
  PANEL_FOOTER_TOKENS,
  PanelFooter,
} from "@src/modules/shared/layouts/blocks";

interface MultiSelectBarProps {
  selectedCount: number;
  visibleItemCount: number;
  deleting: boolean;
  centeredActions?: boolean;
  onSelectAll: () => void;
  onUnselectAll: () => void;
  onDelete: () => void;
  onSetProperty?: () => void;
  onSetStatus?: () => void;
  onSetPriority?: () => void;
  onSetAssignee?: () => void;
}

export const MultiSelectBar: React.FC<MultiSelectBarProps> = ({
  selectedCount,
  visibleItemCount,
  deleting,
  centeredActions = false,
  onSelectAll,
  onUnselectAll,
  onDelete,
  onSetProperty,
  onSetStatus,
  onSetPriority,
  onSetAssignee,
}) => {
  const { t } = useTranslation("projects");

  if (selectedCount === 0) return null;

  const allSelected = selectedCount > 0 && selectedCount === visibleItemCount;

  const quickFieldButtons: Array<{ label: string; onClick: () => void }> = [
    ...(onSetStatus
      ? [
          {
            label: t("workItems.batchStatus.title", {
              defaultValue: "Set status",
            }),
            onClick: onSetStatus,
          },
        ]
      : []),
    ...(onSetPriority
      ? [
          {
            label: t("workItems.batchPriority.title", {
              defaultValue: "Set priority",
            }),
            onClick: onSetPriority,
          },
        ]
      : []),
    ...(onSetAssignee
      ? [
          {
            label: t("workItems.batchAssignee.title", {
              defaultValue: "Set assignee",
            }),
            onClick: onSetAssignee,
          },
        ]
      : []),
    ...(onSetProperty
      ? [
          {
            label: t("workItems.batchProperty.title", {
              defaultValue: "Set property",
            }),
            onClick: onSetProperty,
          },
        ]
      : []),
  ];

  const selectToggleButton = (
    <Button size="small" onClick={allSelected ? onUnselectAll : onSelectAll}>
      {allSelected
        ? t("common:actions.unselectAll")
        : t("common:actions.selectAll")}
    </Button>
  );

  const cancelButton = (
    <Button size="small" variant="secondary" onClick={onUnselectAll}>
      {t("common:actions.cancel")}
    </Button>
  );

  const deleteButton = (
    <Button
      size="small"
      variant="danger"
      appearance="outline"
      icon={<HugeiconsIcon icon={Delete02Icon} data-icon="trash-2" size={14} />}
      disabled={deleting}
      loading={deleting}
      onClick={onDelete}
    >
      {t("workItems.deleteItems", { count: selectedCount })}
    </Button>
  );

  if (centeredActions) {
    return (
      <div
        className={`${PANEL_FOOTER_TOKENS.container} relative justify-center`}
      >
        <div className="absolute left-4 flex min-w-0 items-center gap-2">
          {selectToggleButton}
        </div>
        <div className="flex items-center gap-2">
          {quickFieldButtons.map((action) => (
            <Button
              key={action.label}
              size="small"
              variant="secondary"
              onClick={action.onClick}
            >
              {action.label}
            </Button>
          ))}
          {cancelButton}
          {deleteButton}
        </div>
      </div>
    );
  }

  return (
    <PanelFooter
      left={selectToggleButton}
      secondaryActions={[
        ...quickFieldButtons,
        { label: t("common:actions.cancel"), onClick: onUnselectAll },
      ]}
      primaryAction={{
        label: t("workItems.deleteItems", { count: selectedCount }),
        onClick: onDelete,
        icon: (
          <HugeiconsIcon icon={Delete02Icon} data-icon="trash-2" size={14} />
        ),
        variant: "danger",
        appearance: "outline",
        disabled: deleting,
        loading: deleting,
      }}
    />
  );
};
