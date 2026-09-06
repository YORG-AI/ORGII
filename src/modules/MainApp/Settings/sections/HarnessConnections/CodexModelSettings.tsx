import { useId } from "react";
import { useTranslation } from "react-i18next";

import type { CodexProviderProfile } from "@src/api/tauri/rpc/schemas/agentOrgs";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import {
  SECTION_CONTROL_STYLE,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

export default function CodexModelSettings({
  profile,
  disabled,
  models,
  onChange,
  onFetch,
}: {
  profile: CodexProviderProfile;
  disabled: boolean;
  models: string[];
  onChange: (profile: CodexProviderProfile) => void;
  onFetch: () => void;
}) {
  const { t } = useTranslation("settings");
  const listId = useId();
  const update = (patch: Partial<CodexProviderProfile["models"]>) =>
    onChange({ ...profile, models: { ...profile.models, ...patch } });
  return (
    <>
      <SectionRow
        label={t("codexProfiles.model")}
        description={t("codexProfiles.modelHelp")}
      >
        <div
          className="flex w-full flex-col gap-2"
          style={SECTION_CONTROL_STYLE}
        >
          <Input
            aria-label={t("codexProfiles.model")}
            value={profile.models.model}
            disabled={disabled}
            maxLength={256}
            list={listId}
            onChange={(model) => update({ model })}
          />
          <datalist id={listId}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <Button
            variant="secondary"
            disabled={disabled || !profile.keyId || !profile.endpoint}
            onClick={onFetch}
          >
            {t("claudeProfiles.fetchModels")}
          </Button>
        </div>
      </SectionRow>
      <SectionRow
        label={t("codexProfiles.reasoning")}
        description={t("codexProfiles.reasoningHelp")}
      >
        <Select
          ariaLabel={t("codexProfiles.reasoning")}
          style={SECTION_CONTROL_STYLE}
          disabled={disabled}
          value={profile.models.reasoningEffort ?? "default"}
          options={[
            { value: "default", label: t("codexProfiles.default") },
            ...(["minimal", "low", "medium", "high", "xhigh"] as const).map(
              (value) => ({ value, label: value })
            ),
          ]}
          onChange={(value) =>
            update({
              reasoningEffort:
                value === "default"
                  ? null
                  : (value as CodexProviderProfile["models"]["reasoningEffort"]),
            })
          }
        />
      </SectionRow>
      {(["contextWindow", "autoCompactTokenLimit"] as const).map((field) => (
        <SectionRow
          key={field}
          label={t(`codexProfiles.${field}`)}
          description={t(`codexProfiles.${field}Help`)}
        >
          <Input
            aria-label={t(`codexProfiles.${field}`)}
            style={SECTION_CONTROL_STYLE}
            disabled={disabled}
            type="number"
            min={1}
            max={1_000_000_000}
            step={1}
            placeholder={t("codexProfiles.default")}
            value={
              profile.models[field] === null
                ? ""
                : String(profile.models[field])
            }
            onChange={(value) =>
              update({ [field]: value === "" ? null : Number(value) })
            }
          />
        </SectionRow>
      ))}
    </>
  );
}
