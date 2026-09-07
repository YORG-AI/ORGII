import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { projectApi } from "@src/api/http/project";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import Modal from "@src/scaffold/ModalSystem";
import type { Person } from "@src/types/core/shared";

import { usePropertyDefinitions } from "../hooks/usePropertyDefinitions";

export interface BatchPropertyDialogProps {
  open: boolean;
  orgId: string;
  projectSlug: string | null;
  shortIds: string[];
  members: Person[];
  onClose: () => void;
  onApplied: () => void;
}

export const BatchPropertyDialog: React.FC<BatchPropertyDialogProps> = ({
  open,
  orgId,
  projectSlug,
  shortIds,
  members,
  onClose,
  onApplied,
}) => {
  const { t } = useTranslation("projects");
  const { data: definitions } = usePropertyDefinitions(orgId, open);
  const [propertyId, setPropertyId] = useState<string | null>(null);
  const [textValue, setTextValue] = useState("");
  const [multiValues, setMultiValues] = useState<string[]>([]);
  const [boolValue, setBoolValue] = useState(false);
  const [applying, setApplying] = useState(false);
  const selected = useMemo(
    () => definitions.find((definition) => definition.id === propertyId),
    [definitions, propertyId]
  );

  const propertyOptions = useMemo(
    () =>
      definitions.map((definition) => ({
        value: definition.id,
        label: definition.name,
      })),
    [definitions]
  );

  const selectValueOptions = useMemo(() => {
    if (
      selected?.propertyType === "actor" ||
      selected?.propertyType === "multi_actor"
    ) {
      return members.map((member) => ({
        value: `member:${member.id}`,
        label: member.name,
      }));
    }
    return (selected?.config.options ?? []).map((option) => ({
      value: option.id,
      label: option.name,
    }));
  }, [members, selected]);

  const buildValue = (): unknown | null => {
    if (!selected) return null;
    switch (selected.propertyType) {
      case "checkbox":
        return boolValue;
      case "number": {
        const parsed = Number(textValue);
        return Number.isFinite(parsed) ? parsed : null;
      }
      case "select":
      case "actor":
        return textValue || null;
      case "multi_select":
      case "multi_actor":
        return multiValues.length > 0 ? multiValues : null;
      default:
        return textValue.trim() || null;
    }
  };

  const handleApply = async () => {
    if (!selected) return;
    setApplying(true);
    try {
      const updated = await projectApi.batchSetWorkItemPropertyValue({
        orgId,
        projectSlug,
        shortIds,
        propertyId: selected.id,
        value: buildValue(),
      });
      Message.success(
        t("workItems.batchProperty.applied", {
          defaultValue: `Updated ${updated} items`,
          count: updated,
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

  const valueInput = () => {
    if (!selected) return null;
    switch (selected.propertyType) {
      case "checkbox":
        return (
          <Switch
            checked={boolValue}
            onCheckedChange={setBoolValue}
            ariaLabel={selected.name}
          />
        );
      case "select":
      case "actor":
        return (
          <Select
            value={textValue || undefined}
            options={selectValueOptions}
            onChange={(value) => setTextValue(value as string)}
            placeholder={t("workItems.batchProperty.valuePlaceholder", {
              defaultValue: "Value",
            })}
            size="small"
          />
        );
      case "multi_select":
      case "multi_actor":
        return (
          <Select
            mode="multiple"
            value={multiValues}
            options={selectValueOptions}
            onChange={(value) =>
              setMultiValues((value as Array<string | number>).map(String))
            }
            placeholder={t("workItems.batchProperty.valuePlaceholder", {
              defaultValue: "Value",
            })}
            size="small"
          />
        );
      default:
        return (
          <Input
            value={textValue}
            onChange={(value) => setTextValue(value)}
            placeholder={t("workItems.batchProperty.valuePlaceholder", {
              defaultValue: "Value",
            })}
            size="small"
          />
        );
    }
  };

  return (
    <Modal
      visible={open}
      title={t("workItems.batchProperty.title", {
        defaultValue: "Set property",
      })}
      width={420}
      onCancel={onClose}
      onOk={() => void handleApply()}
      okText={t("common:actions.apply", { defaultValue: "Apply" })}
      cancelText={t("common:actions.cancel", { defaultValue: "Cancel" })}
      okButtonProps={{ disabled: !selected, loading: applying }}
    >
      <div className="flex flex-col gap-3 p-4">
        <p className="text-xs text-text-3">
          {t("workItems.batchProperty.hint", {
            defaultValue: `Applies one property value to ${shortIds.length} selected items. Leave the value empty to clear it.`,
            count: shortIds.length,
          })}
        </p>
        <Select
          value={propertyId ?? undefined}
          options={propertyOptions}
          onChange={(value) => {
            setPropertyId(value as string);
            setTextValue("");
            setMultiValues([]);
            setBoolValue(false);
          }}
          placeholder={t("workItems.batchProperty.propertyPlaceholder", {
            defaultValue: "Property",
          })}
          size="small"
          dataTestId="work-items-batch-property-select"
        />
        {valueInput()}
      </div>
    </Modal>
  );
};

export default BatchPropertyDialog;
