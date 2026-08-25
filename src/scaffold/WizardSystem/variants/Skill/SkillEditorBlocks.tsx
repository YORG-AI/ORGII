/**
 * SkillEditorBlocks
 *
 * Inline sub-components for SkillEditorPanel, extracted to keep
 * SkillEditorPanel.tsx under 600 lines:
 *
 * - SkillRequirementsBlock: required binaries + env vars toggles
 * - BundledFileEntry: path input + CodeMirror editor for a bundled file
 * - DescriptionQualityIndicator: quality badge based on description length
 */
import { AlertTriangle, Check, Trash2 } from "lucide-react";
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Switch from "@src/components/Switch";
import { CodeMirrorEditor } from "@src/features/CodeMirror/Editor";
import type { UseSkillEditorReturn } from "@src/hooks/skills/useSkillEditor";
import type {
  BundledFileDraft,
  SkillEditorDraft,
} from "@src/modules/MainApp/Integrations/store/skills/skillEditorDraftAtom";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { StringListTableEditor } from "@src/scaffold/WizardSystem/shared/StringListTableEditor";
import {
  DESCRIPTION_QUALITY,
  type DescriptionQuality,
} from "@src/types/extensions/types";

// ── SkillRequirementsBlock ────────────────────────────────────────────────────

/** Remount when `key={skillEditorSessionKey}` so switch state matches the opened skill. */
export const SkillRequirementsBlock: React.FC<{
  draft: SkillEditorDraft;
  editor: UseSkillEditorReturn;
}> = ({ draft, editor }) => {
  const { t } = useTranslation("integrations");
  const [binsSectionOn, setBinsSectionOn] = useState(() =>
    draft.requiredBins.some((bin) => bin.trim())
  );
  const [envSectionOn, setEnvSectionOn] = useState(() =>
    draft.requiredEnv.some((env) => env.trim())
  );

  return (
    <SectionContainer>
      <SectionRow
        label={t("skillsHub.binsLabel")}
        description={t("skillsHub.binsDesc")}
      >
        <Switch
          size="default"
          checked={binsSectionOn}
          onCheckedChange={(checked) => {
            setBinsSectionOn(checked);
            if (!checked) editor.updateDraft({ requiredBins: [] });
          }}
        />
      </SectionRow>
      {binsSectionOn && (
        <SectionRow label="" showHeader={false}>
          <StringListTableEditor
            values={draft.requiredBins}
            onChange={(requiredBins) => editor.updateDraft({ requiredBins })}
            valueLabel={t("common:labels.name")}
            placeholder={t("skillsHub.binsPlaceholder")}
            addLabel={t("common:actions.add")}
          />
        </SectionRow>
      )}

      <SectionRow
        label={t("skillsHub.envLabel")}
        description={t("skillsHub.envDesc")}
      >
        <Switch
          size="default"
          checked={envSectionOn}
          onCheckedChange={(checked) => {
            setEnvSectionOn(checked);
            if (!checked) editor.updateDraft({ requiredEnv: [] });
          }}
        />
      </SectionRow>
      {envSectionOn && (
        <SectionRow label="" showHeader={false}>
          <StringListTableEditor
            values={draft.requiredEnv}
            onChange={(requiredEnv) => editor.updateDraft({ requiredEnv })}
            valueLabel={t("common:labels.name")}
            placeholder={t("skillsHub.envPlaceholder")}
            addLabel={t("common:actions.add")}
          />
        </SectionRow>
      )}
    </SectionContainer>
  );
};

// ── BundledFileEntry ──────────────────────────────────────────────────────────

const EXTENSION_TO_LANGUAGE: Record<string, string> = {
  py: "python",
  sh: "shell",
  bash: "shell",
  md: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  js: "javascript",
  ts: "typescript",
  rs: "rust",
};

function languageFromPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXTENSION_TO_LANGUAGE[ext] ?? "plaintext";
}

export const BundledFileEntry: React.FC<{
  file: BundledFileDraft;
  onChange: (updated: BundledFileDraft) => void;
  onRemove: () => void;
}> = ({ file, onChange, onRemove }) => {
  const { t } = useTranslation("integrations");

  return (
    <div className="rounded-lg border border-border-2 bg-bg-2 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Input
          value={file.relativePath}
          onChange={(val: string) => onChange({ ...file, relativePath: val })}
          placeholder={t("skillsHub.filePathPlaceholder")}
          size="default"
          className="flex-1"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
        <Button
          size="small"
          icon={<Trash2 size={14} />}
          iconOnly
          onClick={onRemove}
          title={t("skillsHub.removeFile")}
        />
      </div>
      <div className="h-[150px] overflow-hidden rounded-md border border-border-2">
        <CodeMirrorEditor
          value={file.content}
          onChange={(val) => onChange({ ...file, content: val })}
          language={languageFromPath(file.relativePath)}
          height="150px"
          enableMinimap={false}
          enableDirtyDiff={false}
          enableFindReplace={false}
          enableGoToLine={false}
          registerWithService={false}
        />
      </div>
    </div>
  );
};

// ── DescriptionQualityIndicator ───────────────────────────────────────────────

export const DescriptionQualityIndicator: React.FC<{
  quality: DescriptionQuality;
}> = ({ quality }) => {
  const { t } = useTranslation("integrations");

  if (quality === DESCRIPTION_QUALITY.GOOD) {
    return (
      <span className="flex items-center gap-1 text-xs text-success-6">
        <Check size={12} />
        {t("skillsHub.descriptionQualityGood")}
      </span>
    );
  }
  if (quality === DESCRIPTION_QUALITY.SHORT) {
    return (
      <span className="flex items-center gap-1 text-xs text-warning-6">
        <AlertTriangle size={12} />
        {t("skillsHub.descriptionQualityShort")}
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 text-xs text-danger-6">
      <AlertTriangle size={12} />
      {t("skillsHub.descriptionQualityMissing")}
    </span>
  );
};
