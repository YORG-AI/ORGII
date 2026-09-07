import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { projectApi } from "@src/api/http/project";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import {
  WORK_ITEM_PRIORITY_OPTIONS,
  WORK_ITEM_STATUS_OPTIONS,
} from "@src/modules/ProjectManager/config/manage";
import Modal from "@src/scaffold/ModalSystem";
import type { Person } from "@src/types/core/shared";

import { useCustomStatusOptions } from "../hooks/useStatusDefinitions";
import {
  BATCH_QUICK_FIELD_NO_ASSIGNEE_VALUE,
  type BatchQuickField,
  buildBatchQuickFieldUpdate,
} from "../workItemPartialUpdate";

export interface BatchQuickFieldDialogProps {
  open: boolean;
  field: BatchQuickField;
  orgId: string;
  projectSlug: string | null;
  shortIds: string[];
  members: Person[];
  onClose: () => void;
  onApplied: () => void;
}

const FIELD_TITLE: Record<BatchQuickField, string> = {
  status: "workItems.batchStatus.title",
  priority: "workItems.batchPriority.title",
  assignee: "workItems.batchAssignee.title",
};

const FIELD_DEFAULT_TITLE: Record<BatchQuickField, string> = {
  status: "Set status",
  priority: "Set priority",
  assignee: "Set assignee",
};

export const BatchQuickFieldDialog: React.FC<BatchQuickFieldDialogProps> = ({
  open,
  field,
  orgId,
  projectSlug,
  shortIds,
  members,
  onClose,
  onApplied,
}) => {
  const { t } = useTranslation("projects");
  const [value, setValue] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const customStatusOptions = useCustomStatusOptions(orgId);

  useEffect(() => {
    if (open) setValue(null);
  }, [open, field]);

  const options = useMemo(() => {
    switch (field) {
      case "status":
        return [...WORK_ITEM_STATUS_OPTIONS, ...customStatusOptions].map(
          (option) => ({
            value: option.value,
            label: t(`workItems.statusLabels.${option.value}`, {
              defaultValue: option.label,
            }),
          })
        );
      case "priority":
        return WORK_ITEM_PRIORITY_OPTIONS.map((option) => ({
          value: option.value,
          label: t(`workItems.priorityLabels.${option.value}`, {
            defaultValue: option.label,
          }),
        }));
      case "assignee":
        return [
          {
            value: BATCH_QUICK_FIELD_NO_ASSIGNEE_VALUE,
            label: t("workItems.properties.noAssignee", {
              defaultValue: "No assignee",
            }),
          },
          ...members.map((member) => ({
            value: member.id,
            label: member.name,
          })),
        ];
      default:
        return [];
    }
  }, [customStatusOptions, field, members, t]);

  const handleApply = async () => {
    if (!value || !projectSlug) return;
    setApplying(true);
    try {
      const updates = buildBatchQuickFieldUpdate(field, value);
      const result = await projectApi.batchUpdateWorkItems(
        projectSlug,
        shortIds,
        updates
      );
      Message.success(
        t("workItems.batchProperty.applied", {
          defaultValue: `Updated ${result.updated.length} items`,
          count: result.updated.length,
        })
      );
      onApplied();
      onClose();
    } catch (error) {
      Message.error(String(error));
    } finally {
      setApplying(false);
    }
  };

  return (
    <Modal
      visible={open}
      title={t(FIELD_TITLE[field], {
        defaultValue: FIELD_DEFAULT_TITLE[field],
      })}
      width={360}
      onCancel={onClose}
      onOk={() => void handleApply()}
      okText={t("common:actions.apply", { defaultValue: "Apply" })}
      cancelText={t("common:actions.cancel", { defaultValue: "Cancel" })}
      okButtonProps={{ disabled: !value || !projectSlug, loading: applying }}
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-text-3">
          {t("workItems.batchField.hint", {
            defaultValue: `Applies to ${shortIds.length} selected items.`,
            count: shortIds.length,
          })}
        </p>
        <Select
          value={value ?? undefined}
          options={options}
          onChange={(next) => setValue(next as string)}
          placeholder={t("workItems.batchProperty.valuePlaceholder", {
            defaultValue: "Value",
          })}
          size="small"
          dataTestId={`work-items-batch-${field}-select`}
        />
      </div>
    </Modal>
  );
};

export default BatchQuickFieldDialog;
