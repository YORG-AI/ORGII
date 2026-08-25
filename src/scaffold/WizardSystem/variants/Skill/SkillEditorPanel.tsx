/**
 * SkillEditorPanel — single-step wizard for creating or editing a SKILL.md file.
 *
 * Layout uses SectionContainer + SectionRow (settings-style) inside
 * WizardShell > WizardStepLayout for consistent look with OS Agent config.
 */
import { AlertTriangle, Plus } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Markdown from "@src/components/MarkDown";
import Radio from "@src/components/Radio";
import type { RadioValue } from "@src/components/Radio";
import Switch from "@src/components/Switch";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import { CodeMirrorEditor } from "@src/features/CodeMirror/Editor";
import type { UseSkillEditorReturn } from "@src/hooks/skills/useSkillEditor";
import {
  SKILL_SCOPE,
  type SkillScope,
} from "@src/modules/MainApp/Integrations/store/skills/skillEditorDraftAtom";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  WizardShell,
  WizardStepLayout,
} from "@src/scaffold/WizardSystem/primitives";

import {
  BundledFileEntry,
  DescriptionQualityIndicator,
  SkillRequirementsBlock,
} from "./SkillEditorBlocks";

const TOKEN_WARNING_THRESHOLD = 5000;

interface SkillEditorPanelProps {
  editor: UseSkillEditorReturn;
  onBack: () => void;
  onSaved: () => void;
  hasProject?: boolean;
}

const SkillEditorPanel: React.FC<SkillEditorPanelProps> = ({
  editor,
  onBack,
  onSaved,
  hasProject = false,
}) => {
  const { t } = useTranslation("integrations");
  const {
    draft,
    isEditing,
    saving,
    saveError,
    validationError,
    descriptionQuality,
    estimatedTokenCount,
  } = editor;

  const [activeTab, setActiveTab] = useState("edit");

  const wizardTitle = isEditing
    ? t("skillsHub.editSkill")
    : t("skillsHub.createSkill");

  const localizedTabs = useMemo<TabPillItem[]>(
    () => [
      {
        key: "edit",
        label: t("skillsHub.editTab"),
      },
      {
        key: "preview",
        label: t("skillsHub.previewTab"),
      },
    ],
    [t]
  );

  const handleSave = useCallback(async () => {
    const success = await editor.save();
    if (success) {
      onSaved();
    }
  }, [editor, onSaved]);

  const handleCancel = useCallback(() => {
    editor.discard();
    onBack();
  }, [editor, onBack]);

  if (!draft) {
    return (
      <WizardShell title={wizardTitle} onCancel={handleCancel}>
        <Placeholder
          variant="empty"
          placement="detail-panel"
          fillParentHeight
          title={t("skillsHub.editorNoDraftTitle")}
          subtitle={t("skillsHub.editorNoDraftDesc")}
          action={{
            label: t("common:actions.back"),
            onClick: handleCancel,
          }}
        />
      </WizardShell>
    );
  }

  const skillEditorSessionKey = `${draft.editingSkillPath ?? ""}\u0000${draft.editingSkillName ?? ""}`;

  const errorMessage = validationError ?? saveError;
  const exceedsTokenBudget = estimatedTokenCount > TOKEN_WARNING_THRESHOLD;

  return (
    <WizardShell title={wizardTitle} onCancel={handleCancel}>
      <WizardStepLayout
        currentStep={1}
        totalSteps={1}
        onCancel={handleCancel}
        actions={
          <Button
            variant="primary"
            size="small"
            onClick={handleSave}
            disabled={saving || !draft.name.trim()}
            loading={saving}
          >
            {t("skillsHub.saveSkill")}
          </Button>
        }
      >
        {errorMessage && (
          <div className="mb-4">
            <InlineAlert type="danger" title={t("common:status.error")}>
              {errorMessage}
            </InlineAlert>
          </div>
        )}

        <>
          <SectionContainer>
            <SectionRow
              label={t("skillsHub.nameLabel")}
              description={t("skillsHub.nameDesc")}
              required
            >
              <Input
                value={draft.name}
                onChange={(value: string) =>
                  editor.updateDraft({ name: value })
                }
                placeholder={t("skillsHub.namePlaceholder")}
                disabled={isEditing}
                size="default"
                style={SECTION_CONTROL_STYLE}
                allowClear
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </SectionRow>

            <SectionRow
              label={t("skillsHub.descriptionLabel")}
              description={t("skillsHub.descriptionHint")}
            >
              <Input
                value={draft.description}
                onChange={(value: string) =>
                  editor.updateDraft({ description: value })
                }
                placeholder={t("skillsHub.descriptionPlaceholder")}
                size="default"
                style={SECTION_CONTROL_STYLE}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </SectionRow>

            <SectionRow
              label={t("skillsHub.versionLabel")}
              description={t("skillsHub.versionDesc")}
            >
              <Input
                value={draft.version}
                onChange={(value: string) =>
                  editor.updateDraft({ version: value })
                }
                placeholder="1.0.0"
                size="default"
                style={SECTION_CONTROL_STYLE}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </SectionRow>
          </SectionContainer>

          <SectionContainer>
            <SectionRow
              label={t("skillsHub.alwaysActiveLabel")}
              description={t("skillsHub.alwaysActiveTooltip")}
            >
              <Switch
                checked={draft.alwaysActive}
                onCheckedChange={(checked) =>
                  editor.updateDraft({ alwaysActive: checked })
                }
              />
            </SectionRow>

            {hasProject && (
              <SectionRow
                label={t("skillsHub.scopeLabel")}
                description={
                  isEditing
                    ? t("skillsHub.scopeDescEdit")
                    : t("skillsHub.scopeDesc")
                }
              >
                <Radio.Group
                  type="button"
                  size="small"
                  value={draft.scope}
                  onChange={(val: RadioValue) =>
                    editor.updateDraft({ scope: String(val) as SkillScope })
                  }
                >
                  <Radio value={SKILL_SCOPE.GLOBAL}>
                    {t("skillsHub.scopeGlobal")}
                  </Radio>
                  <Radio value={SKILL_SCOPE.WORKSPACE}>
                    {t("skillsHub.scopeWorkspace")}
                  </Radio>
                </Radio.Group>
              </SectionRow>
            )}
          </SectionContainer>

          <SkillRequirementsBlock
            key={skillEditorSessionKey}
            draft={draft}
            editor={editor}
          />

          <SectionContainer>
            <SectionRow
              label={t("skillsHub.licenseLabel")}
              description={t("skillsHub.licenseDesc")}
            >
              <Input
                value={draft.license}
                onChange={(value: string) =>
                  editor.updateDraft({ license: value })
                }
                placeholder="Apache-2.0"
                size="default"
                style={SECTION_CONTROL_STYLE}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </SectionRow>

            <SectionRow
              label={t("skillsHub.compatibilityLabel")}
              description={t("skillsHub.compatibilityDesc")}
            >
              <Input
                value={draft.compatibility}
                onChange={(value: string) =>
                  editor.updateDraft({ compatibility: value })
                }
                placeholder={t("skillsHub.compatibilityPlaceholder")}
                size="default"
                style={SECTION_CONTROL_STYLE}
                autoComplete="off"
                autoCorrect="off"
                spellCheck={false}
              />
            </SectionRow>
          </SectionContainer>

          <SectionContainer>
            <SectionRow
              label={t("skillsHub.contentLabel")}
              description={t("skillsHub.contentDesc")}
              required
            >
              <TabPill
                tabs={localizedTabs}
                activeTab={activeTab}
                onChange={setActiveTab}
                variant="pill"
                fillWidth={false}
              />
            </SectionRow>

            <div className="pb-3">
              <div className="min-h-[300px]">
                {activeTab === "edit" ? (
                  <div className="h-full min-h-[300px] overflow-hidden rounded-lg border border-border-2 bg-bg-2">
                    <CodeMirrorEditor
                      value={draft.body}
                      onChange={(value) => editor.updateDraft({ body: value })}
                      language="markdown"
                      height="100%"
                      enableMinimap={false}
                      enableDirtyDiff={false}
                      enableFindReplace={false}
                      enableGoToLine={false}
                      registerWithService={false}
                    />
                  </div>
                ) : (
                  <div className="min-h-[300px] rounded-lg border border-border-2 bg-bg-2 p-4 text-sm text-text-2">
                    {draft.body.trim() ? (
                      <Markdown textContent={draft.body} />
                    ) : (
                      <span className="text-text-3">
                        {t("skillsHub.previewEmpty")}
                      </span>
                    )}
                  </div>
                )}
              </div>

              <div className="mt-3 flex items-center gap-3">
                <span
                  className={`text-xs ${exceedsTokenBudget ? "text-warning-6" : "text-text-3"}`}
                >
                  {exceedsTokenBudget && (
                    <AlertTriangle
                      size={11}
                      className="mr-1 inline-block align-[-1px]"
                    />
                  )}
                  {t("skillsHub.tokenEstimate", {
                    count: estimatedTokenCount,
                  })}
                  {exceedsTokenBudget && ` — ${t("skillsHub.tokenWarning")}`}
                </span>
                <span className="text-xs text-text-3">&middot;</span>
                <DescriptionQualityIndicator quality={descriptionQuality} />
              </div>
            </div>
          </SectionContainer>

          <SectionContainer>
            <SectionRow
              label={t("skillsHub.bundledFilesLabel")}
              description={t("skillsHub.bundledFilesDesc")}
            >
              <Button
                size="default"
                icon={<Plus size={14} />}
                onClick={() =>
                  editor.updateDraft({
                    bundledFileDrafts: [
                      ...draft.bundledFileDrafts,
                      { relativePath: "", content: "" },
                    ],
                  })
                }
              >
                {t("skillsHub.addFileButton")}
              </Button>
            </SectionRow>

            {draft.bundledFileDrafts.length > 0 && (
              <div className="flex flex-col gap-4 pb-3">
                {draft.bundledFileDrafts.map((file, idx) => (
                  <BundledFileEntry
                    key={idx}
                    file={file}
                    onChange={(updated) => {
                      const next = [...draft.bundledFileDrafts];
                      next[idx] = updated;
                      editor.updateDraft({ bundledFileDrafts: next });
                    }}
                    onRemove={() => {
                      editor.updateDraft({
                        bundledFileDrafts: draft.bundledFileDrafts.filter(
                          (_, filterIdx) => filterIdx !== idx
                        ),
                      });
                    }}
                  />
                ))}
              </div>
            )}
          </SectionContainer>
        </>
      </WizardStepLayout>
    </WizardShell>
  );
};

export default SkillEditorPanel;
