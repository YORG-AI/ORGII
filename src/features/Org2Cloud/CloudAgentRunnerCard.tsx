/**
 * "Agent task runner" Settings card (agent-pickup design §4 UI item 7).
 *
 * Per-cloud-org defaults for comment-task runs started from a session thread
 * ("Run here"): which key-vault account's tokens, which model, and which
 * agent exec mode the runner passes to its ONE `sendMessage` drive turn
 * (`RunCommentTaskInput.agentOptions`). Persisted in
 * `agentTaskRunnerSettingsAtom` (zod localStorage, per-org record); the READ
 * side (`resolveAgentRunnerSettings`) defaults mode to 'build'.
 *
 * The card states the trust boundary explicitly — runs execute on THIS
 * machine with the selected account's tokens — because assigning a task in
 * the cloud never runs anything anywhere else (design §4: the human "Run
 * here" click is the per-run consent).
 *
 * Pickers: account/model options come from the same key-vault data the chat
 * model picker reads (`useModelAccountLookup` / `accountHasModel`), rendered
 * with the shared `Select` — the pill/palette selector UIs are
 * spotlight-coupled, so v1 reuses the DATA layer, not those components.
 * Clearing account/model falls back to the forked session's own defaults.
 *
 * The auto-run toggle is the owner opt-in for the headless auto-claim plane
 * (`kickCommentTaskRunner`). It defaults OFF: a teammate's @agent mention
 * never spends the owner's tokens until the owner turns it on here.
 */
import {
  SECTION_CONTROL_STYLE,
  SECTION_VALUE_SMALL_MUTED_CLASSES,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { useAtom, useAtomValue } from "jotai";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SelectOption } from "@src/components/Select";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import { AGENT_EXEC_MODES } from "@src/config/sessionCreatorConfig";
import {
  accountHasModel,
  accountModelIds,
  useModelAccountLookup,
} from "@src/hooks/models/useModelAccountLookup";

import {
  agentTaskRunnerSettingsAtom,
  resolveAgentRunnerSettings,
  withAgentRunnerAutoRun,
  withAgentRunnerSetting,
} from "./agentTaskRunnerSettingsAtom";
import { org2CloudOrgsAtom } from "./org2CloudOrgsAtom";

const CloudAgentRunnerCard: React.FC = () => {
  const { t } = useTranslation("navigation");
  const cloudOrgs = useAtomValue(org2CloudOrgsAtom);
  const [settingsByOrg, setSettingsByOrg] = useAtom(
    agentTaskRunnerSettingsAtom
  );
  const { accounts } = useModelAccountLookup();

  // Selected org, self-healing when the org list changes (leave/refetch).
  const [pickedOrgId, setPickedOrgId] = useState<string | null>(null);
  const orgId =
    pickedOrgId !== null && cloudOrgs.some((org) => org.orgId === pickedOrgId)
      ? pickedOrgId
      : (cloudOrgs[0]?.orgId ?? null);

  const resolved = useMemo(
    () =>
      orgId !== null ? resolveAgentRunnerSettings(settingsByOrg, orgId) : null,
    [settingsByOrg, orgId]
  );

  const orgOptions = useMemo<SelectOption[]>(
    () => cloudOrgs.map((org) => ({ value: org.orgId, label: org.name })),
    [cloudOrgs]
  );

  /** Enabled key-vault accounts only — a disabled key can never run. */
  const runnableAccounts = useMemo(
    () => accounts.filter((account) => account.enabled),
    [accounts]
  );

  const accountOptions = useMemo<SelectOption[]>(
    () =>
      runnableAccounts.map((account) => ({
        value: account.id,
        label: `${account.name} · ${account.modelType}`,
        triggerLabel: account.name,
      })),
    [runnableAccounts]
  );

  const selectedAccountId = resolved?.accountId;
  const selectedAccount = useMemo(
    () =>
      selectedAccountId !== undefined
        ? runnableAccounts.find((account) => account.id === selectedAccountId)
        : undefined,
    [runnableAccounts, selectedAccountId]
  );

  // Selected account ⇒ its enabled models; no account ⇒ the union across
  // enabled accounts (same universe the chat model picker offers).
  const modelOptions = useMemo<SelectOption[]>(() => {
    const modelIds = new Set<string>();
    const sourceAccounts =
      selectedAccount !== undefined ? [selectedAccount] : runnableAccounts;
    for (const account of sourceAccounts) {
      for (const modelId of accountModelIds(account)) {
        if (accountHasModel(account, modelId)) modelIds.add(modelId);
      }
    }
    return [...modelIds]
      .sort((a, b) => a.localeCompare(b))
      .map((modelId) => ({ value: modelId, label: modelId }));
  }, [selectedAccount, runnableAccounts]);

  const modeOptions = useMemo<SelectOption[]>(
    () =>
      AGENT_EXEC_MODES.map((entry) => ({
        value: entry.id,
        label: t(`sessions:${entry.i18nKey}`, { defaultValue: entry.name }),
      })),
    [t]
  );

  const handleAccountChange = useCallback(
    (value: string | undefined) => {
      if (orgId === null) return;
      setSettingsByOrg((previous) => {
        let next = withAgentRunnerSetting(previous, orgId, "accountId", value);
        // A stored model that the newly-picked account cannot serve is
        // cleared in the same write — the drive turn must never pair an
        // account with a model it does not have.
        const storedModel = next[orgId]?.model;
        if (storedModel !== undefined && value !== undefined) {
          const nextAccount = runnableAccounts.find(
            (account) => account.id === value
          );
          if (!nextAccount || !accountHasModel(nextAccount, storedModel)) {
            next = withAgentRunnerSetting(next, orgId, "model", undefined);
          }
        }
        return next;
      });
    },
    [orgId, runnableAccounts, setSettingsByOrg]
  );

  const handleFieldChange = useCallback(
    (field: "model" | "mode", value: string | undefined) => {
      if (orgId === null) return;
      setSettingsByOrg((previous) =>
        withAgentRunnerSetting(previous, orgId, field, value)
      );
    },
    [orgId, setSettingsByOrg]
  );

  const handleAutoRunChange = useCallback(
    (enabled: boolean) => {
      if (orgId === null) return;
      setSettingsByOrg((previous) =>
        withAgentRunnerAutoRun(previous, orgId, enabled)
      );
    },
    [orgId, setSettingsByOrg]
  );

  // No signed-in cloud org ⇒ nothing to configure (same degradation as the
  // orgs atom: [] when signed out or offline).
  if (orgId === null || resolved === null) return null;

  return (
    <SectionContainer>
      <SectionRow
        label={t("cloud.agentRunner.title")}
        description={t("cloud.agentRunner.desc")}
      >
        <span
          className={SECTION_VALUE_SMALL_MUTED_CLASSES}
          data-testid="org2-cloud-agent-runner-notice"
        >
          {t("cloud.agentRunner.machineNotice")}
        </span>
      </SectionRow>
      {cloudOrgs.length > 1 && (
        <SectionRow label={t("cloud.agentRunner.orgLabel")}>
          <Select
            value={orgId}
            options={orgOptions}
            onChange={(value) => setPickedOrgId(String(value))}
            style={SECTION_CONTROL_STYLE}
            dataTestId="org2-cloud-agent-runner-org"
          />
        </SectionRow>
      )}
      <SectionRow
        label={t("cloud.agentRunner.autoRunLabel")}
        description={t("cloud.agentRunner.autoRunDesc")}
      >
        <Switch
          checked={resolved.autoRunEnabled}
          onChange={handleAutoRunChange}
          ariaLabel={t("cloud.agentRunner.autoRunLabel")}
          dataTestId="org2-cloud-agent-runner-autorun"
        />
      </SectionRow>
      <SectionRow label={t("cloud.agentRunner.accountLabel")}>
        <Select
          value={resolved.accountId}
          options={accountOptions}
          placeholder={t("cloud.agentRunner.accountPlaceholder")}
          allowClear
          onClear={() => handleAccountChange(undefined)}
          onChange={(value) => handleAccountChange(String(value))}
          style={SECTION_CONTROL_STYLE}
          dataTestId="org2-cloud-agent-runner-account"
        />
      </SectionRow>
      <SectionRow label={t("cloud.agentRunner.modelLabel")}>
        <Select
          value={resolved.model}
          options={modelOptions}
          placeholder={t("cloud.agentRunner.modelPlaceholder")}
          allowClear
          showSearch
          onClear={() => handleFieldChange("model", undefined)}
          onChange={(value) => handleFieldChange("model", String(value))}
          style={SECTION_CONTROL_STYLE}
          dataTestId="org2-cloud-agent-runner-model"
        />
      </SectionRow>
      <SectionRow label={t("cloud.agentRunner.modeLabel")}>
        <Select
          value={resolved.mode}
          options={modeOptions}
          onChange={(value) => handleFieldChange("mode", String(value))}
          style={SECTION_CONTROL_STYLE}
          dataTestId="org2-cloud-agent-runner-mode"
        />
      </SectionRow>
    </SectionContainer>
  );
};

export default CloudAgentRunnerCard;
