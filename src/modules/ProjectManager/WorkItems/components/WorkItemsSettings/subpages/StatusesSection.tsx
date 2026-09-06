import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type StatusDefinition,
  WORK_ITEM_STATUS_CATEGORIES,
  type WorkItemStatusCategory,
  projectApi,
} from "@src/api/http/project";
import Button from "@src/components/Button";
import ColorPicker from "@src/components/ColorPicker";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import {
  Add01Icon,
  ArchiveIcon,
  HugeiconsIcon,
  LockIcon,
  RotateLeft01Icon,
} from "@src/icons";
import { WORK_ITEM_STATUS_OPTIONS } from "@src/modules/ProjectManager/config/manage";
import {
  SECTION_ACTION_GAP_CLASSES,
  SectionContainer,
  SectionHeading,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { CARD_ROW_TOKENS } from "@src/modules/shared/layouts/blocks";

import {
  useCustomStatusDefinitions,
  useEnsureStatusDefinitions,
} from "../../../hooks/useStatusDefinitions";

export interface StatusesSectionProps {
  orgId: string;
  showTitle?: boolean;
}

const DEFAULT_STATUS_COLOR = "#6b7280";

function slugifyKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
}

export const StatusesSection: React.FC<StatusesSectionProps> = ({
  orgId,
  showTitle = true,
}) => {
  const { t } = useTranslation("projects");
  const refresh = useEnsureStatusDefinitions(orgId);
  const definitions = useCustomStatusDefinitions(orgId);
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftCategory, setDraftCategory] =
    useState<WorkItemStatusCategory>("planned");
  const [draftColor, setDraftColor] = useState(DEFAULT_STATUS_COLOR);
  const [saving, setSaving] = useState(false);

  const categoryOptions = useMemo(
    () =>
      WORK_ITEM_STATUS_CATEGORIES.map((category) => ({
        value: category,
        label:
          WORK_ITEM_STATUS_OPTIONS.find((option) => option.value === category)
            ?.label ?? category,
      })),
    []
  );

  const handleAdd = useCallback(async () => {
    const key = slugifyKey(draftName);
    if (!draftName.trim() || !key) return;
    setSaving(true);
    try {
      await projectApi.upsertStatusDefinition({
        orgId,
        key,
        name: draftName.trim(),
        category: draftCategory,
        color: draftColor,
      });
      setDraftName("");
      setIsAdding(false);
      await refresh();
    } catch (error) {
      Message.error(String(error));
    } finally {
      setSaving(false);
    }
  }, [draftCategory, draftColor, draftName, orgId, refresh]);

  const handleRename = useCallback(
    async (definition: StatusDefinition, name: string) => {
      if (!name.trim() || name.trim() === definition.name) return;
      try {
        await projectApi.upsertStatusDefinition({
          id: definition.id,
          orgId,
          name: name.trim(),
        });
        await refresh();
      } catch (error) {
        Message.error(String(error));
      }
    },
    [orgId, refresh]
  );

  const handleColor = useCallback(
    async (definition: StatusDefinition, color: string) => {
      try {
        await projectApi.upsertStatusDefinition({
          id: definition.id,
          orgId,
          name: definition.name,
          color,
        });
        await refresh();
      } catch (error) {
        Message.error(String(error));
      }
    },
    [orgId, refresh]
  );

  const handleArchive = useCallback(
    async (definition: StatusDefinition) => {
      try {
        await projectApi.setStatusDefinitionArchived(
          orgId,
          definition.id,
          definition.archivedAt == null
        );
        await refresh();
      } catch (error) {
        Message.error(String(error));
      }
    },
    [orgId, refresh]
  );

  const sectionBody = (
    <SectionContainer>
      <SectionRow
        label={t("settings.statusesBuiltin", {
          defaultValue: "Built-in statuses",
        })}
        description={t("settings.statusesBuiltinDescription", {
          defaultValue: "The standard workflow buckets. Always available.",
        })}
      >
        <span />
      </SectionRow>
      <SectionRow label="" indent showHeader={false}>
        <div className="flex flex-wrap items-center gap-2 py-1">
          {WORK_ITEM_STATUS_OPTIONS.map((option) => (
            <span
              key={option.value}
              className="inline-flex items-center gap-1.5 rounded-full bg-fill-2 px-2 py-0.5 text-xs text-text-2"
            >
              <HugeiconsIcon
                icon={LockIcon}
                data-icon="lock"
                size={11}
                aria-hidden
                className="text-text-4"
              />
              {option.label}
            </span>
          ))}
        </div>
      </SectionRow>

      <SectionRow
        label={t("settings.statusesCustom", {
          defaultValue: "Custom statuses",
        })}
        description={t("settings.statusesCustomDescription", {
          defaultValue:
            "Named aliases over a built-in bucket. Filters, counts, and boards treat them as their bucket.",
        })}
      >
        <div className={SECTION_ACTION_GAP_CLASSES}>
          <span className="text-xs text-text-1">{definitions.length}</span>
          <Button
            onClick={() => setIsAdding((current) => !current)}
            icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
            iconOnly
            disabled={saving}
            data-testid="work-item-statuses-add-toggle"
          />
        </div>
      </SectionRow>

      <SectionRow label="" indent showHeader={false}>
        {isAdding && (
          <div className="flex items-center gap-2 py-1.5">
            <ColorPicker value={draftColor} onChange={setDraftColor} />
            <Input
              value={draftName}
              onChange={(value) => setDraftName(value)}
              placeholder={t("settings.statusNamePlaceholder", {
                defaultValue: "Status name",
              })}
              size="small"
              autoFocus
              data-testid="work-item-statuses-name-input"
            />
            <Select
              value={draftCategory}
              options={categoryOptions}
              onChange={(value) =>
                setDraftCategory(value as WorkItemStatusCategory)
              }
              size="small"
            />
            <Button
              onClick={() => void handleAdd()}
              disabled={!draftName.trim() || saving}
              loading={saving}
              size="small"
              data-testid="work-item-statuses-add-confirm"
            >
              {t("common:actions.add", { defaultValue: "Add" })}
            </Button>
          </div>
        )}
        {definitions.length === 0 && !isAdding ? (
          <div className={CARD_ROW_TOKENS.emptyState}>
            {t("settings.noCustomStatuses", {
              defaultValue: "No custom statuses yet.",
            })}
          </div>
        ) : (
          definitions.map((definition) => (
            <div
              key={definition.id}
              className="flex items-center gap-2 py-1.5"
              data-testid={`work-item-status-row-${definition.key}`}
            >
              <ColorPicker
                value={definition.color ?? DEFAULT_STATUS_COLOR}
                onChange={(color) => void handleColor(definition, color)}
              />
              <Input
                defaultValue={definition.name}
                size="small"
                onBlur={(event) =>
                  void handleRename(definition, event.target.value)
                }
              />
              <span className="text-xs whitespace-nowrap text-text-4">
                {
                  categoryOptions.find(
                    (option) => option.value === definition.category
                  )?.label
                }
              </span>
              <Button
                icon={
                  definition.archivedAt != null ? (
                    <HugeiconsIcon
                      icon={RotateLeft01Icon}
                      data-icon="rotate-ccw"
                      size={14}
                    />
                  ) : (
                    <HugeiconsIcon
                      icon={ArchiveIcon}
                      data-icon="archive"
                      size={14}
                    />
                  )
                }
                iconOnly
                size="small"
                variant="tertiary"
                appearance="ghost"
                onClick={() => void handleArchive(definition)}
                aria-label={
                  definition.archivedAt != null
                    ? t("settings.statusRestore", {
                        defaultValue: "Restore status",
                      })
                    : t("settings.statusArchive", {
                        defaultValue: "Archive status",
                      })
                }
              />
            </div>
          ))
        )}
      </SectionRow>
    </SectionContainer>
  );

  if (!showTitle) return sectionBody;

  return (
    <SectionHeading
      title={t("settings.sidebarStatuses", { defaultValue: "Statuses" })}
    >
      {sectionBody}
    </SectionHeading>
  );
};

export default StatusesSection;
