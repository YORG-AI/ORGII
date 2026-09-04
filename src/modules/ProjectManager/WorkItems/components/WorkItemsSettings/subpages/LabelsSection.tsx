/**
 * LabelsSection — Label management for project settings.
 * Add, edit, remove labels used across work items.
 *
 * Buffered editing: changes are staged locally and only persisted
 * when the user clicks Save. Cancel discards all pending changes.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import ColorPicker, {
  DEFAULT_COLOR_PRESETS,
} from "@src/components/ColorPicker";
import Input from "@src/components/Input";
import { useKeyboardSave } from "@src/hooks/keyboard";
import { useUndoStackWithRestore } from "@src/hooks/ui";
import { Add01Icon, Delete02Icon, HugeiconsIcon } from "@src/icons";
import {
  SECTION_ACTION_GAP_CLASSES,
  SectionContainer,
  SectionHeading,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { CARD_ROW_TOKENS } from "@src/modules/shared/layouts/blocks";
import type { Label } from "@src/types/core/shared";

export interface LabelsSectionProps {
  labels: Label[];
  onUpdateLabels: (labels: Label[]) => Promise<void>;
  showTitle?: boolean;
}

function randomColor(): string {
  return DEFAULT_COLOR_PRESETS[
    Math.floor(Math.random() * DEFAULT_COLOR_PRESETS.length)
  ];
}

const LabelsSection: React.FC<LabelsSectionProps> = ({
  labels,
  onUpdateLabels,
  showTitle = true,
}) => {
  const { t } = useTranslation("projects");

  const [draft, setDraft] = useState<Label[]>(labels);
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(randomColor);

  const { snapshot, clear: clearUndo } = useUndoStackWithRestore<Label[]>({
    keyboardShortcut: true,
    currentValue: draft,
    onRestore: setDraft,
  });

  // Reset draft when labels prop changes (React derived-state pattern)
  const [prevLabels, setPrevLabels] = useState(labels);
  if (prevLabels !== labels) {
    setPrevLabels(labels);
    setDraft(labels);
  }

  // Clear undo history when labels source changes
  useEffect(() => {
    clearUndo();
  }, [labels, clearUndo]);

  const hasChanges = useMemo(() => {
    if (draft.length !== labels.length) return true;
    return draft.some((draftLabel, idx) => {
      const original = labels[idx];
      if (!original) return true;
      return (
        draftLabel.id !== original.id ||
        draftLabel.name !== original.name ||
        draftLabel.color !== original.color
      );
    });
  }, [draft, labels]);

  const handleAddLabel = useCallback(() => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    snapshot(draft);
    const newLabel: Label = {
      id: `lbl-${trimmed.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
      name: trimmed,
      color: newColor,
    };
    setDraft((prev) => [...prev, newLabel]);
    setNewName("");
    setNewColor(randomColor());
    setIsAdding(false);
  }, [newName, newColor, draft, snapshot]);

  const handleCancelAdd = useCallback(() => {
    setIsAdding(false);
    setNewName("");
  }, []);

  const handleStartAdd = useCallback(() => {
    setNewName("");
    setNewColor(randomColor());
    setIsAdding(true);
  }, []);

  const handleUpdateName = useCallback(
    (labelId: string, value: string) => {
      if (!value.trim()) return;
      snapshot(draft);
      setDraft((prev) =>
        prev.map((label) =>
          label.id === labelId ? { ...label, name: value.trim() } : label
        )
      );
    },
    [draft, snapshot]
  );

  const handleUpdateColor = useCallback(
    (labelId: string, color: string) => {
      snapshot(draft);
      setDraft((prev) =>
        prev.map((label) =>
          label.id === labelId ? { ...label, color } : label
        )
      );
    },
    [draft, snapshot]
  );

  const handleDelete = useCallback(
    (labelId: string) => {
      snapshot(draft);
      setDraft((prev) => prev.filter((label) => label.id !== labelId));
    },
    [draft, snapshot]
  );

  const handleSave = useCallback(() => {
    onUpdateLabels(draft);
  }, [draft, onUpdateLabels]);

  const handleCancel = useCallback(() => {
    setDraft(labels);
    clearUndo();
    setIsAdding(false);
    setNewName("");
  }, [labels, clearUndo]);

  useKeyboardSave(handleSave, hasChanges);

  const sectionBody = (
    <SectionContainer>
      <SectionRow
        label={t("properties.labels")}
        description={t("settings.labelsDescription")}
      >
        <div className={SECTION_ACTION_GAP_CLASSES}>
          <span className="text-xs text-text-1">{draft.length}</span>
          <Button
            onClick={handleStartAdd}
            icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={14} />}
            iconOnly
            disabled={isAdding}
          />
        </div>
      </SectionRow>

      <SectionRow label="" indent showHeader={false}>
        {isAdding && (
          <div className="flex items-center gap-2 py-1.5">
            <ColorPicker value={newColor} onChange={setNewColor} />
            <Input
              value={newName}
              onChange={setNewName}
              placeholder={t("settings.labelNamePlaceholder")}
              autoFocus
              className="flex-1"
              onKeyDown={(event) => {
                if (event.key === "Enter") handleAddLabel();
                if (event.key === "Escape") handleCancelAdd();
              }}
            />
            <Button onClick={handleAddLabel}>{t("common:actions.add")}</Button>
            <Button onClick={handleCancelAdd}>
              {t("common:actions.cancel")}
            </Button>
          </div>
        )}

        {draft.length === 0 && !isAdding ? (
          <div className={CARD_ROW_TOKENS.emptyState}>
            {t("settings.noLabels")}
          </div>
        ) : (
          draft.map((label) => (
            <div key={label.id} className="flex items-center gap-2 py-1.5">
              <ColorPicker
                value={label.color}
                onChange={(color) => handleUpdateColor(label.id, color)}
              />
              <Input
                defaultValue={label.name}
                placeholder={t("settings.labelNamePlaceholder")}
                className="flex-1"
                onBlur={(event) =>
                  handleUpdateName(label.id, event.target.value)
                }
              />
              <Button
                icon={
                  <HugeiconsIcon
                    icon={Delete02Icon}
                    data-icon="trash-2"
                    size={14}
                  />
                }
                iconOnly
                onClick={() => handleDelete(label.id)}
              />
            </div>
          ))
        )}
      </SectionRow>

      {hasChanges && (
        <div
          className={`${SECTION_ACTION_GAP_CLASSES} justify-end px-4 pt-1 pb-3`}
        >
          <Button size="small" onClick={handleCancel}>
            {t("common:actions.cancel")}
          </Button>
          <Button variant="primary" size="small" onClick={handleSave}>
            {t("common:actions.save")}
          </Button>
        </div>
      )}
    </SectionContainer>
  );

  if (!showTitle) return sectionBody;

  return (
    <SectionHeading title={t("properties.labels")}>
      {sectionBody}
    </SectionHeading>
  );
};

export default LabelsSection;
