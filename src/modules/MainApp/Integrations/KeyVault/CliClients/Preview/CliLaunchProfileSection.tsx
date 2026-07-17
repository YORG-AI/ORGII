import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type {
  CliLaunchProfileView,
  CliPermissionMode,
} from "@src/api/tauri/rpc/schemas/agentOrgs";
import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import TabPill from "@src/components/TabPill";
import Textarea from "@src/components/Textarea";
import { SectionRow } from "@src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { InlineCardColumnStack } from "../../shared/InlineCardPrimitives";

interface CliLaunchProfileSectionProps {
  agentName: string;
  variant?: "inline" | "settings";
}

interface DraftState {
  permissionMode: CliPermissionMode;
  launchCommandText: string;
  envText: string;
}

const MODE_LABEL_KEYS: Record<CliPermissionMode, string> = {
  plan: "cliLaunchProfiles.plan",
  manual: "cliLaunchProfiles.manual",
  auto_edit: "cliLaunchProfiles.autoEdit",
  full_permission: "cliLaunchProfiles.fullPermission",
};

function buildLaunchCommandText(command: string, args: string[]) {
  return [command, ...args].filter(Boolean).join(" ");
}

function splitLaunchCommandText(text: string) {
  const [command = "", ...args] = parseArgs(text);
  return { command, args };
}

function envToText(env: Record<string, string>) {
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

function parseArgs(text: string) {
  return text.trim().split(/\s+/).filter(Boolean);
}

function parseLines(text: string) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseEnv(text: string) {
  return Object.fromEntries(
    parseLines(text).map((line) => {
      const separatorIndex = line.indexOf("=");
      if (separatorIndex === -1) {
        return [line, ""];
      }
      return [
        line.slice(0, separatorIndex).trim(),
        line.slice(separatorIndex + 1),
      ];
    })
  );
}

function defaultArgsForMode(
  profile: CliLaunchProfileView,
  mode: CliPermissionMode
) {
  return (
    profile.modeDefaults.find((defaults) => defaults.mode === mode)?.args ?? []
  );
}

function defaultEnvForMode(
  profile: CliLaunchProfileView,
  mode: CliPermissionMode
) {
  return (
    profile.modeDefaults.find((defaults) => defaults.mode === mode)?.env ?? {}
  );
}

function profileToDraft(profile: CliLaunchProfileView): DraftState {
  return {
    permissionMode: profile.permissionMode,
    launchCommandText: buildLaunchCommandText(profile.command, profile.args),
    envText: envToText(profile.env),
  };
}

export const CliLaunchProfileSection: React.FC<
  CliLaunchProfileSectionProps
> = ({ agentName, variant = "inline" }) => {
  const { t } = useTranslation("integrations");
  const [profile, setProfile] = useState<CliLaunchProfileView | null>(null);
  const [draft, setDraft] = useState<DraftState | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [resetting, setResetting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    rpc.agentOrgs.launchProfiles
      .get({ agentName })
      .then((nextProfile) => {
        if (cancelled) return;
        setProfile(nextProfile);
        setDraft(profileToDraft(nextProfile));
      })
      .catch((error) => {
        if (!cancelled) {
          Message.error({ content: String(error) });
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [agentName]);

  const modeTabs = useMemo(
    () =>
      (profile?.supportedPermissionModes ?? []).map((mode) => ({
        key: mode,
        label: t(MODE_LABEL_KEYS[mode]),
      })),
    [profile?.supportedPermissionModes, t]
  );

  const dirty = useMemo(() => {
    if (!profile || !draft) return false;
    return (
      profile.permissionMode !== draft.permissionMode ||
      buildLaunchCommandText(profile.command, profile.args) !==
        draft.launchCommandText ||
      envToText(profile.env) !== draft.envText
    );
  }, [draft, profile]);

  const handleModeChange = (mode: string) => {
    if (!profile) return;
    const permissionMode = mode as CliPermissionMode;
    setDraft(() => ({
      permissionMode,
      launchCommandText: buildLaunchCommandText(
        profile.command,
        defaultArgsForMode(profile, permissionMode)
      ),
      envText: envToText(defaultEnvForMode(profile, permissionMode)),
    }));
  };

  const handleCancel = () => {
    if (!profile) return;
    setDraft(profileToDraft(profile));
  };

  const handleSave = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const { command, args } = splitLaunchCommandText(draft.launchCommandText);
      const nextProfile = await rpc.agentOrgs.launchProfiles.update({
        agentName,
        permissionMode: draft.permissionMode,
        commandOverride: command,
        argsOverride: args,
        envOverride: parseEnv(draft.envText),
      });
      setProfile(nextProfile);
      setDraft(profileToDraft(nextProfile));
      Message.success({ content: t("cliLaunchProfiles.saved") });
    } catch (error) {
      Message.error({ content: String(error) });
    } finally {
      setSaving(false);
    }
  };

  const handleReset = async () => {
    setResetting(true);
    try {
      const nextProfile = await rpc.agentOrgs.launchProfiles.reset({
        agentName,
      });
      setProfile(nextProfile);
      setDraft(profileToDraft(nextProfile));
      Message.success({ content: t("cliLaunchProfiles.resetDone") });
    } catch (error) {
      Message.error({ content: String(error) });
    } finally {
      setResetting(false);
    }
  };

  if (loading) {
    return (
      <Placeholder variant="loading" title={t("cliLaunchProfiles.loading")} />
    );
  }

  if (!profile || !draft) {
    return (
      <Placeholder variant="empty" title={t("cliLaunchProfiles.unavailable")} />
    );
  }

  if (variant === "settings") {
    return (
      <>
        <SectionRow label={t("cliLaunchProfiles.title")} layout="vertical">
          <div className="max-w-xs">
            <TabPill
              tabs={modeTabs}
              activeTab={draft.permissionMode}
              onChange={handleModeChange}
              variant="pill"
              fillWidth={false}
              size="small"
              buttonStyle
            />
          </div>
        </SectionRow>
        <SectionRow label={t("cliLaunchProfiles.command")} layout="vertical">
          <Input
            size="default"
            value={draft.launchCommandText}
            placeholder={buildLaunchCommandText(
              profile.defaultCommand,
              profile.args
            )}
            className="w-full"
            onChange={(value) =>
              setDraft((current) =>
                current ? { ...current, launchCommandText: value } : current
              )
            }
          />
        </SectionRow>
        <SectionRow
          label={t("cliLaunchProfiles.environment")}
          layout="vertical"
        >
          <Textarea
            size="default"
            rows={2}
            resize="vertical"
            value={draft.envText}
            placeholder={t("cliLaunchProfiles.envPlaceholder")}
            onChange={(value) =>
              setDraft((current) =>
                current ? { ...current, envText: value } : current
              )
            }
          />
        </SectionRow>
        <SectionRow showHeader={false}>
          <div className="flex items-center justify-between gap-2">
            <Button
              variant="secondary"
              size="default"
              onClick={handleReset}
              loading={resetting}
            >
              {t("common:actions.reset")}
            </Button>
            <div className="flex items-center gap-2">
              <Button
                variant="secondary"
                size="default"
                onClick={handleCancel}
                disabled={!dirty}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                variant="primary"
                size="default"
                onClick={handleSave}
                loading={saving}
                disabled={!dirty}
              >
                {t("common:actions.save")}
              </Button>
            </div>
          </div>
        </SectionRow>
      </>
    );
  }

  return (
    <InlineCardColumnStack>
      <div className="flex flex-col gap-2">
        <div className="text-[12px] font-medium text-text-1">
          {t("cliLaunchProfiles.title")}
        </div>
        <div className="max-w-xs">
          <TabPill
            tabs={modeTabs}
            activeTab={draft.permissionMode}
            onChange={handleModeChange}
            variant="pill"
            fillWidth={false}
            size="small"
            buttonStyle
          />
        </div>
      </div>

      <label className="flex flex-col gap-1 text-[11px] text-text-3">
        {t("cliLaunchProfiles.command")}
        <Input
          size="small"
          value={draft.launchCommandText}
          placeholder={buildLaunchCommandText(
            profile.defaultCommand,
            profile.args
          )}
          onChange={(value) =>
            setDraft((current) =>
              current ? { ...current, launchCommandText: value } : current
            )
          }
        />
      </label>

      <label className="flex flex-col gap-1 text-[11px] text-text-3">
        {t("cliLaunchProfiles.environment")}
        <Textarea
          size="small"
          rows={2}
          resize="vertical"
          value={draft.envText}
          placeholder={t("cliLaunchProfiles.envPlaceholder")}
          onChange={(value) =>
            setDraft((current) =>
              current ? { ...current, envText: value } : current
            )
          }
        />
      </label>
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="secondary"
          size="small"
          onClick={handleReset}
          loading={resetting}
        >
          {t("common:actions.reset")}
        </Button>
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            size="small"
            onClick={handleCancel}
            disabled={!dirty}
          >
            {t("common:actions.cancel")}
          </Button>
          <Button
            variant="primary"
            size="small"
            onClick={handleSave}
            loading={saving}
            disabled={!dirty}
          >
            {t("common:actions.save")}
          </Button>
        </div>
      </div>
    </InlineCardColumnStack>
  );
};
