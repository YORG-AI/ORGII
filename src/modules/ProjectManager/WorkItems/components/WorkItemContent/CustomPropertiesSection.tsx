import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type PropertyDefinition,
  type PropertyType,
  type WorkItemPropertyValue,
  type WorkItemScope,
  projectApi,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Select, { type SelectOption } from "@src/components/Select";
import {
  Add01Icon,
  ArchiveIcon,
  Cancel01Icon,
  HugeiconsIcon,
  ListChevronsDownUpIcon,
} from "@src/icons";
import { ActivityHeaderActionButton } from "@src/modules/shared/components/ActivityTimeline";

import {
  WORK_ITEM_THREAD_TOKENS,
  WorkItemThreadSection,
} from "../WorkItemThread";

interface CustomPropertiesSectionProps {
  projectSlug?: string | null;
  orgId?: string | null;
  shortId?: string | null;
  editable: boolean;
}

interface PropertyValueEditorProps {
  property: PropertyDefinition;
  value: unknown;
  disabled: boolean;
  onSave: (value: unknown | null) => Promise<void>;
}

const PROPERTY_TYPES: PropertyType[] = [
  "text",
  "number",
  "select",
  "multi_select",
  "date",
  "checkbox",
  "url",
];

function PropertyValueEditor({
  property,
  value,
  disabled,
  onSave,
}: PropertyValueEditorProps) {
  const { t } = useTranslation("projects");
  const [draft, setDraft] = useState(() =>
    value === null || value === undefined ? "" : String(value)
  );

  if (property.propertyType === "checkbox") {
    return (
      <div data-testid={`work-item-property-${property.id}`}>
        <Checkbox
          checked={value === true}
          disabled={disabled}
          size="small"
          onCheckedChange={(checked) => void onSave(checked)}
        >
          {value === true
            ? t("workItems.properties.yes", { defaultValue: "Yes" })
            : t("workItems.properties.no", { defaultValue: "No" })}
        </Checkbox>
      </div>
    );
  }

  if (
    property.propertyType === "select" ||
    property.propertyType === "multi_select"
  ) {
    const options: SelectOption[] = property.config.options.map((option) => ({
      value: option.id,
      label: option.name,
    }));
    const selectValue =
      property.propertyType === "multi_select"
        ? Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : []
        : typeof value === "string"
          ? value
          : undefined;
    return (
      <Select
        value={selectValue}
        mode={property.propertyType === "multi_select" ? "multiple" : "single"}
        options={options}
        allowClear
        disabled={disabled}
        size="small"
        ariaLabel={property.name}
        dataTestId={`work-item-property-${property.id}`}
        className="w-full"
        onClear={() => void onSave(null)}
        onChange={(next) => void onSave(next)}
      />
    );
  }

  const handleBlur = () => {
    const trimmed = draft.trim();
    if (!trimmed) {
      void onSave(null);
      return;
    }
    if (property.propertyType === "number") {
      const number = Number(trimmed);
      if (Number.isFinite(number)) void onSave(number);
      return;
    }
    void onSave(trimmed);
  };

  return (
    <Input
      value={draft}
      type={
        property.propertyType === "number"
          ? "number"
          : property.propertyType === "url"
            ? "url"
            : "text"
      }
      disabled={disabled}
      size="small"
      placeholder={
        property.propertyType === "date"
          ? t("workItems.properties.datePlaceholder", {
              defaultValue: "YYYY-MM-DD",
            })
          : undefined
      }
      onChange={setDraft}
      onBlur={handleBlur}
      data-testid={`work-item-property-${property.id}`}
    />
  );
}

const CustomPropertiesSection: React.FC<CustomPropertiesSectionProps> = ({
  projectSlug,
  orgId,
  shortId,
  editable,
}) => {
  const { t } = useTranslation("projects");
  const resolvedOrgId = orgId || "personal-org";
  const scope = useMemo<WorkItemScope | null>(
    () =>
      shortId
        ? {
            projectSlug: projectSlug ?? null,
            orgId: resolvedOrgId,
            workItemId: shortId,
          }
        : null,
    [projectSlug, resolvedOrgId, shortId]
  );
  const [definitions, setDefinitions] = useState<PropertyDefinition[]>([]);
  const [values, setValues] = useState<WorkItemPropertyValue[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [busyPropertyId, setBusyPropertyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftType, setDraftType] = useState<PropertyType>("text");
  const [draftOptions, setDraftOptions] = useState("");

  const reload = useCallback(async () => {
    if (!scope) {
      setDefinitions([]);
      setValues([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const [nextDefinitions, nextValues] = await Promise.all([
        projectApi.listPropertyDefinitions(scope.orgId),
        projectApi.listWorkItemPropertyValues(scope),
      ]);
      setDefinitions(nextDefinitions);
      setValues(nextValues);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setIsLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const valuesByPropertyId = useMemo(
    () => new Map(values.map((entry) => [entry.definition.id, entry.value])),
    [values]
  );
  const typeOptions = useMemo<SelectOption[]>(
    () =>
      PROPERTY_TYPES.map((type) => ({
        value: type,
        label: type.replace("_", " "),
      })),
    []
  );

  const handleSaveValue = useCallback(
    async (propertyId: string, value: unknown | null) => {
      if (!scope) return;
      setBusyPropertyId(propertyId);
      try {
        await projectApi.setWorkItemPropertyValue(scope, propertyId, value);
        await reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyPropertyId(null);
      }
    },
    [reload, scope]
  );

  const handleCreate = useCallback(async () => {
    const name = draftName.trim();
    if (!name) return;
    const optionNames = draftOptions
      .split(",")
      .map((option) => option.trim())
      .filter(Boolean);
    if (
      (draftType === "select" || draftType === "multi_select") &&
      optionNames.length === 0
    ) {
      setError(
        t("workItems.properties.optionsRequired", {
          defaultValue: "Select properties require comma-separated options.",
        })
      );
      return;
    }
    setBusyPropertyId("new");
    try {
      await projectApi.upsertPropertyDefinition({
        orgId: resolvedOrgId,
        name,
        propertyType: draftType,
        config: {
          options: optionNames.map((option, index) => ({
            id: `option_${Date.now()}_${index}`,
            name: option,
          })),
        },
        position: definitions.length,
      });
      setDraftName("");
      setDraftOptions("");
      setDraftType("text");
      setShowCreate(false);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusyPropertyId(null);
    }
  }, [
    definitions.length,
    draftName,
    draftOptions,
    draftType,
    reload,
    resolvedOrgId,
    t,
  ]);

  const handleArchive = useCallback(
    async (propertyId: string) => {
      setBusyPropertyId(propertyId);
      try {
        await projectApi.archivePropertyDefinition(propertyId);
        await reload();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusyPropertyId(null);
      }
    },
    [reload]
  );

  if (!scope) return null;

  return (
    <WorkItemThreadSection
      testId="work-item-custom-properties"
      icon={
        <HugeiconsIcon
          icon={ListChevronsDownUpIcon}
          data-icon="list-chevrons-up-down"
          size={14}
          strokeWidth={1.8}
          className="shrink-0 text-text-3"
          aria-hidden
        />
      }
      title={
        <span className="font-normal">
          {t("workItems.properties.title", {
            defaultValue: "Custom properties",
          })}
        </span>
      }
      action={
        editable ? (
          <ActivityHeaderActionButton
            icon={
              showCreate ? (
                <HugeiconsIcon icon={Cancel01Icon} data-icon="x" size={12} />
              ) : (
                <HugeiconsIcon icon={Add01Icon} data-icon="plus" size={12} />
              )
            }
            label={
              showCreate
                ? t("common:actions.cancel", { defaultValue: "Cancel" })
                : t("workItems.properties.add", {
                    defaultValue: "Add property",
                  })
            }
            onClick={() => setShowCreate((current) => !current)}
            data-testid="work-item-property-add-toggle"
          />
        ) : null
      }
    >
      <div className="flex flex-col gap-2">
        {error ? (
          <InlineAlert
            type="danger"
            title={t("workItems.properties.updateFailed", {
              defaultValue: "Property update failed",
            })}
          >
            {error}
          </InlineAlert>
        ) : null}

        {showCreate ? (
          <div
            className="grid grid-cols-1 gap-2 rounded-lg bg-fill-1 p-2 md:grid-cols-2"
            data-testid="work-item-property-create-form"
          >
            <Input
              value={draftName}
              onChange={setDraftName}
              size="small"
              placeholder={t("workItems.properties.namePlaceholder", {
                defaultValue: "Property name",
              })}
              data-testid="work-item-property-name"
            />
            <Select
              value={draftType}
              options={typeOptions}
              size="small"
              ariaLabel={t("workItems.properties.type", {
                defaultValue: "Property type",
              })}
              dataTestId="work-item-property-type"
              onChange={(value) => setDraftType(value as PropertyType)}
            />
            {draftType === "select" || draftType === "multi_select" ? (
              <Input
                value={draftOptions}
                onChange={setDraftOptions}
                size="small"
                placeholder={t("workItems.properties.optionsPlaceholder", {
                  defaultValue: "Options, comma separated",
                })}
                className="md:col-span-2"
                data-testid="work-item-property-options"
              />
            ) : null}
            <div className="flex justify-end md:col-span-2">
              <Button
                variant="primary"
                size="small"
                onClick={() => void handleCreate()}
                loading={busyPropertyId === "new"}
                disabled={!draftName.trim()}
                data-testid="work-item-property-create"
              >
                {t("common:actions.create", { defaultValue: "Create" })}
              </Button>
            </div>
          </div>
        ) : null}

        {isLoading ? (
          <p className="px-0 py-2 text-[12px] text-text-3">
            {t("workItems.properties.loading", {
              defaultValue: "Loading properties…",
            })}
          </p>
        ) : definitions.length === 0 ? (
          <p className="px-0 py-2 text-[12px] text-text-3">
            {t("workItems.properties.empty", {
              defaultValue: "No custom properties yet.",
            })}
          </p>
        ) : (
          <div className="flex flex-col gap-0.5">
            {definitions.map((property) => (
              <div
                key={property.id}
                className={`flex min-h-8 items-center gap-3 rounded-lg ${WORK_ITEM_THREAD_TOKENS.alignedRowPadding}`}
              >
                <div className="w-36 shrink-0">
                  <p className="truncate text-[13px] font-medium leading-5 text-text-2">
                    {property.name}
                  </p>
                  <p className="text-[11px] capitalize leading-4 text-text-4">
                    {property.propertyType.replace("_", " ")}
                  </p>
                </div>
                <div className="min-w-0 flex-1">
                  <PropertyValueEditor
                    key={`${property.id}:${JSON.stringify(valuesByPropertyId.get(property.id))}`}
                    property={property}
                    value={valuesByPropertyId.get(property.id)}
                    disabled={!editable || busyPropertyId === property.id}
                    onSave={(value) => handleSaveValue(property.id, value)}
                  />
                </div>
                {editable ? (
                  <Button
                    variant="tertiary"
                    appearance="ghost"
                    size="mini"
                    shape="circle"
                    iconOnly
                    icon={
                      <HugeiconsIcon
                        icon={ArchiveIcon}
                        data-icon="archive"
                        size={13}
                      />
                    }
                    title={t("workItems.properties.archive", {
                      defaultValue: "Archive property",
                    })}
                    aria-label={t("workItems.properties.archiveNamed", {
                      defaultValue: `Archive ${property.name}`,
                      name: property.name,
                    })}
                    onClick={() => void handleArchive(property.id)}
                    disabled={busyPropertyId === property.id}
                  />
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
    </WorkItemThreadSection>
  );
};

export default CustomPropertiesSection;
