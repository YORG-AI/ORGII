import { useId } from "react";
import { useTranslation } from "react-i18next";

import type {
  ClaudeProviderProfile,
  ClaudeRole,
} from "@src/api/tauri/rpc/schemas/agentOrgs";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import {
  SECTION_CONTROL_STYLE,
  SECTION_DESCRIPTION_CLASSES,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

export const MAIN_ROLES = ["sonnet", "opus", "fable", "haiku"] as const;
const LABELS: Record<ClaudeRole, string> = {
  sonnet: "Sonnet",
  opus: "Opus",
  fable: "Fable",
  haiku: "Haiku",
  subagent: "Subagent",
};

export default function ClaudeModelMappings({
  profile,
  disabled,
  models,
  onChange,
  onFetch,
}: {
  profile: ClaudeProviderProfile;
  disabled: boolean;
  models: string[];
  onChange: (profile: ClaudeProviderProfile) => void;
  onFetch: () => void;
}) {
  const { t } = useTranslation("settings");
  const listId = useId();
  const roles: ClaudeRole[] =
    profile.target === "claude_code"
      ? [...MAIN_ROLES, "subagent"]
      : [...MAIN_ROLES];
  const update = (
    role: ClaudeRole,
    value: Partial<ClaudeProviderProfile["models"]["roles"]["sonnet"]>
  ) => {
    const entry = {
      model: "",
      displayName: "",
      context1m: false,
      ...profile.models.roles[role],
      ...value,
    };
    const next = { ...profile.models.roles, [role]: entry };
    if (role === "subagent" && !entry.model) delete next.subagent;
    onChange({ ...profile, models: { ...profile.models, roles: next } });
  };
  return (
    <>
      <SectionRow label={t("claudeProfiles.defaultRole")}>
        <Select
          ariaLabel={t("claudeProfiles.defaultRole")}
          value={profile.models.defaultRole}
          disabled={disabled}
          style={SECTION_CONTROL_STYLE}
          options={MAIN_ROLES.map((role) => ({
            value: role,
            label: LABELS[role],
          }))}
          onChange={(value) => {
            if (MAIN_ROLES.includes(value as (typeof MAIN_ROLES)[number]))
              onChange({
                ...profile,
                models: {
                  ...profile.models,
                  defaultRole: value as (typeof MAIN_ROLES)[number],
                },
              });
          }}
        />
      </SectionRow>
      <SectionRow showHeader={false}>
        <div className="@container flex w-full min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-text-1">
              {t("claudeProfiles.mapping")}
            </span>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="secondary"
                disabled={
                  disabled ||
                  !profile.models.roles[profile.models.defaultRole].model
                }
                onClick={() => {
                  const entry =
                    profile.models.roles[profile.models.defaultRole];
                  const next = { ...profile.models.roles };
                  for (const role of MAIN_ROLES)
                    next[role] = {
                      ...entry,
                      context1m: role === "haiku" ? false : entry.context1m,
                    };
                  if (profile.target === "claude_code")
                    next.subagent = { ...entry, displayName: "" };
                  onChange({
                    ...profile,
                    models: { ...profile.models, roles: next },
                  });
                }}
              >
                {t("claudeProfiles.useOne")}
              </Button>
              <Button
                variant="secondary"
                disabled={disabled || !profile.keyId || !profile.endpoint}
                onClick={onFetch}
              >
                {t("claudeProfiles.fetchModels")}
              </Button>
            </div>
          </div>
          <p className={SECTION_DESCRIPTION_CLASSES}>
            {t("claudeProfiles.mappingHelp")}
          </p>
          <datalist id={listId}>
            {models.map((model) => (
              <option key={model} value={model} />
            ))}
          </datalist>
          <div
            className="flex flex-col gap-3"
            role="group"
            aria-label={t("claudeProfiles.mapping")}
          >
            <div
              className="hidden gap-2 px-3 text-xs text-text-3 @[800px]:grid @[800px]:grid-cols-[6rem_1fr_1fr_5rem]"
              aria-hidden="true"
            >
              <span>{t("claudeProfiles.role")}</span>
              <span>{t("claudeProfiles.displayName")}</span>
              <span>{t("claudeProfiles.requestModel")}</span>
              <span>1M</span>
            </div>
            {roles.map((role) => {
              const entry = profile.models.roles[role];
              return (
                <div
                  key={role}
                  className="grid grid-cols-1 items-start gap-2 rounded-lg border border-border-2 p-3 @[600px]:grid-cols-2 @[800px]:grid-cols-[6rem_1fr_1fr_5rem]"
                >
                  <div className="flex h-8 items-center text-sm font-medium text-text-2">
                    {LABELS[role]}
                  </div>
                  <Input
                    aria-label={`${LABELS[role]} ${t("claudeProfiles.displayName")}`}
                    value={entry?.displayName ?? ""}
                    placeholder={t(
                      role === "subagent"
                        ? "claudeProfiles.noLabel"
                        : "claudeProfiles.displayName"
                    )}
                    disabled={disabled || role === "subagent"}
                    maxLength={120}
                    onChange={(displayName) => update(role, { displayName })}
                  />
                  <Input
                    aria-label={`${LABELS[role]} ${t("claudeProfiles.requestModel")}`}
                    value={entry?.model ?? ""}
                    list={listId}
                    placeholder={t(
                      role === "subagent"
                        ? "claudeProfiles.inherit"
                        : "claudeProfiles.requestModel"
                    )}
                    disabled={disabled}
                    maxLength={256}
                    onChange={(model) => update(role, { model })}
                  />
                  {role !== "haiku" && (
                    <Checkbox
                      disabled={disabled || !entry?.model}
                      checked={entry?.context1m ?? false}
                      onCheckedChange={(context1m) =>
                        update(role, { context1m })
                      }
                    >
                      <span className="sr-only">{LABELS[role]} </span>1M
                    </Checkbox>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </SectionRow>
    </>
  );
}
