/**
 * RepoDetailForms
 *
 * Inline add-row forms for the Repo Detail page:
 * - AddEnvVarRow: adds a key/value environment variable
 * - AddScriptRow: adds a named shell script with category
 *
 * Extracted from RepoDetailPage.tsx to keep it under 600 lines.
 */
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import { Add01Icon, HugeiconsIcon } from "@src/icons";
import type { ScriptCategory } from "@src/modules/shared/launchpad/types";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { CATEGORY_OPTIONS } from "./RepoDetailConfig";

// ── AddEnvVarRow ──────────────────────────────────────────────────────────────

export const AddEnvVarRow: React.FC<{
  onAdd: (key: string, value: string) => Promise<void>;
}> = ({ onAdd }) => {
  const { t } = useTranslation("navigation");
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);

  const handleAdd = useCallback(async () => {
    if (!key.trim()) return;
    setSaving(true);
    try {
      await onAdd(key.trim(), value);
      setKey("");
      setValue("");
    } finally {
      setSaving(false);
    }
  }, [key, value, onAdd]);

  return (
    <SectionContainer padding="compact">
      <SectionRow label={t("launchpad.detail.newEnvKey")} compact>
        <Input
          size="small"
          placeholder="KEY_NAME"
          value={key}
          onChange={setKey}
          style={{ width: "100%" }}
        />
      </SectionRow>
      <SectionRow label={t("launchpad.detail.newEnvValue")} compact>
        <div className="flex items-center gap-2">
          <Input
            size="small"
            placeholder={t("launchpad.detail.valuePlaceholder")}
            value={value}
            onChange={setValue}
            style={{ width: "100%" }}
          />
          <Button
            variant="primary"
            size="mini"
            icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={12} />}
            loading={saving}
            disabled={!key.trim()}
            onClick={handleAdd}
          >
            {t("common:actions.add")}
          </Button>
        </div>
      </SectionRow>
    </SectionContainer>
  );
};

// ── AddScriptRow ──────────────────────────────────────────────────────────────

export const AddScriptRow: React.FC<{
  onAdd: (
    name: string,
    command: string,
    category: ScriptCategory
  ) => Promise<void>;
}> = ({ onAdd }) => {
  const { t } = useTranslation("navigation");
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [category, setCategory] = useState<ScriptCategory>("other");
  const [saving, setSaving] = useState(false);

  const handleAdd = useCallback(async () => {
    if (!name.trim() || !command.trim()) return;
    setSaving(true);
    try {
      await onAdd(name.trim(), command.trim(), category);
      setName("");
      setCommand("");
      setCategory("other");
    } finally {
      setSaving(false);
    }
  }, [name, command, category, onAdd]);

  return (
    <SectionContainer padding="compact">
      <SectionRow label={t("launchpad.detail.scriptName")} compact>
        <Input
          size="small"
          placeholder={t("launchpad.detail.scriptNamePlaceholder")}
          value={name}
          onChange={setName}
          style={{ width: "100%" }}
        />
      </SectionRow>
      <SectionRow label={t("launchpad.detail.scriptCommand")} compact>
        <Input
          size="small"
          placeholder="npm run dev"
          value={command}
          onChange={setCommand}
          style={{ width: "100%" }}
        />
      </SectionRow>
      <SectionRow label={t("launchpad.detail.scriptCategory")} compact>
        <div className="flex items-center gap-2">
          <Select
            size="small"
            value={category}
            onChange={(val) => setCategory(val as ScriptCategory)}
            options={CATEGORY_OPTIONS}
            style={{ width: 120 }}
          />
          <Button
            variant="primary"
            size="mini"
            icon={<HugeiconsIcon icon={Add01Icon} data-icon="plus" size={12} />}
            loading={saving}
            disabled={!name.trim() || !command.trim()}
            onClick={handleAdd}
          >
            {t("common:actions.add")}
          </Button>
        </div>
      </SectionRow>
    </SectionContainer>
  );
};
