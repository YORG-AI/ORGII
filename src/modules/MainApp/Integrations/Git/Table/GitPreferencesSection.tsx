import { useAtom, useAtomValue, useSetAtom } from "jotai";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import { Delete02Icon, HugeiconsIcon } from "@src/icons";
import SaveableTextarea from "@src/modules/shared/components/SaveableTextarea";
import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { HintWithInfo } from "@src/modules/shared/layouts/blocks";
import {
  ORGII_COAUTHOR_EMAIL,
  ORGII_COAUTHOR_NAME,
} from "@src/services/git/operations/commitAttribution";
import { saveSettingAtom, settingAtom } from "@src/store/settings/settingsAtom";
import {
  GIT_PULL_STRATEGIES,
  type GitPullStrategy,
  gitAutoCreatePrAtom,
  gitAutoFetchAtom,
  gitAutoFetchIntervalAtom,
  gitCoauthorAttributionEnabledAtom,
  gitPrAttributionEnabledAtom,
  gitPullStrategyAtom,
  gitWorktreeCleanupIntervalHoursAtom,
  gitWorktreeMaxCountAtom,
} from "@src/store/ui/editorSettingsAtom";

import { useGitProxySettings } from "./useGitProxySettings";

const AUTO_FETCH_INTERVALS = [
  { value: 30, labelKey: "editor.git.interval30s" },
  { value: 60, labelKey: "editor.git.interval1m" },
  { value: 180, labelKey: "editor.git.interval3m" },
  { value: 300, labelKey: "editor.git.interval5m" },
  { value: 600, labelKey: "editor.git.interval10m" },
  { value: 1800, labelKey: "editor.git.interval30m" },
  { value: 3600, labelKey: "editor.git.interval1h" },
];

const WORKTREE_MAX_COUNT_OPTIONS = [1, 2, 4, 6, 8, 12, 16, 24, 32].map(
  (count) => ({
    value: count,
    label: String(count),
    dataTestId: `settings-git-worktree-max-count-option-${count}`,
  })
);

const WORKTREE_CLEANUP_INTERVAL_OPTIONS = [1, 3, 6, 12, 24, 48, 72, 168].map(
  (hours) => ({
    value: hours,
    labelKey: `editor.git.worktreeCleanupInterval${hours}h`,
    dataTestId: `settings-git-worktree-cleanup-interval-option-${hours}`,
  })
);

const GitPreferencesSection: React.FC = () => {
  const { t } = useTranslation("integrations");
  const { t: tSettings } = useTranslation("settings");
  const { t: tCommon } = useTranslation("common");
  const [pullStrategy, setPullStrategy] = useAtom(gitPullStrategyAtom);
  const [autoFetch, setAutoFetch] = useAtom(gitAutoFetchAtom);
  const [autoFetchInterval, setAutoFetchInterval] = useAtom(
    gitAutoFetchIntervalAtom
  );
  const [autoCreatePr, setAutoCreatePr] = useAtom(gitAutoCreatePrAtom);
  const commitInstructions = useAtomValue(
    settingAtom("git.prompts.commitInstructions")
  );
  const pullRequestInstructions = useAtomValue(
    settingAtom("git.prompts.pullRequestInstructions")
  );
  const saveSetting = useSetAtom(saveSettingAtom);
  const [coauthorAttributionEnabled, setCoauthorAttributionEnabled] = useAtom(
    gitCoauthorAttributionEnabledAtom
  );
  const [prAttributionEnabled, setPrAttributionEnabled] = useAtom(
    gitPrAttributionEnabledAtom
  );
  const [worktreeMaxCount, setWorktreeMaxCount] = useAtom(
    gitWorktreeMaxCountAtom
  );
  const [worktreeCleanupIntervalHours, setWorktreeCleanupIntervalHours] =
    useAtom(gitWorktreeCleanupIntervalHoursAtom);
  const {
    proxyInfo,
    proxyHttpDraft,
    setProxyHttpDraft,
    proxyHttpsDraft,
    setProxyHttpsDraft,
    proxySaving,
    proxyDirty,
    handleProxyCancel,
    handleProxySave,
    handleProxyClear,
  } = useGitProxySettings();

  return (
    <>
      <SectionContainer title={t("git.preferencesTitle")}>
        <SectionRow
          label={tSettings("editor.git.pullStrategy")}
          description={tSettings("editor.git.pullStrategyDesc")}
        >
          <div className="flex items-center gap-2">
            <HintWithInfo
              content={tSettings("editor.git.pullStrategyHint")}
              position="left"
            />
            <Select
              value={pullStrategy}
              size="default"
              onChange={(value) => setPullStrategy(value as GitPullStrategy)}
              options={GIT_PULL_STRATEGIES.map((strategy) => ({
                label: tSettings(strategy.labelKey),
                value: strategy.value,
              }))}
              style={SECTION_CONTROL_STYLE}
            />
          </div>
        </SectionRow>

        <SectionRow
          label={tSettings("editor.git.autoFetch")}
          description={tSettings("editor.git.autoFetchDesc")}
        >
          <Switch checked={autoFetch} onCheckedChange={setAutoFetch} />
        </SectionRow>

        {autoFetch && (
          <SectionRow
            label={tSettings("editor.git.autoFetchInterval")}
            description={tSettings("editor.git.autoFetchIntervalDesc")}
            indent
          >
            <Select
              value={autoFetchInterval}
              size="default"
              onChange={(value) => setAutoFetchInterval(Number(value))}
              options={AUTO_FETCH_INTERVALS.map((interval) => ({
                label: tSettings(interval.labelKey),
                value: interval.value,
              }))}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
        )}

        <SectionRow
          label={t("git.autoCreatePr")}
          description={t("git.autoCreatePrDesc")}
        >
          <Switch checked={autoCreatePr} onCheckedChange={setAutoCreatePr} />
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("git.promptInstructionsTitle")}>
        <SectionRow
          label={t("git.commitInstructions")}
          description={t("git.commitInstructionsDesc")}
          layout="vertical"
        >
          <SaveableTextarea
            value={commitInstructions}
            onSave={(value) =>
              saveSetting({
                key: "git.prompts.commitInstructions",
                value: value.trim(),
              })
            }
            placeholder={t("git.commitInstructionsPlaceholder")}
            autoSize={{ minRows: 4, maxRows: 10 }}
            maxLength={4000}
            maxWords={200}
            showWordLimit
            dataTestId="settings-git-commit-instructions"
            saveButtonDataTestId="settings-git-commit-instructions-save"
          />
        </SectionRow>

        <SectionRow
          label={t("git.pullRequestInstructions")}
          description={t("git.pullRequestInstructionsDesc")}
          layout="vertical"
        >
          <SaveableTextarea
            value={pullRequestInstructions}
            onSave={(value) =>
              saveSetting({
                key: "git.prompts.pullRequestInstructions",
                value: value.trim(),
              })
            }
            placeholder={t("git.pullRequestInstructionsPlaceholder")}
            autoSize={{ minRows: 4, maxRows: 10 }}
            maxLength={4000}
            maxWords={200}
            showWordLimit
            dataTestId="settings-git-pull-request-instructions"
            saveButtonDataTestId="settings-git-pull-request-instructions-save"
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("git.worktreeTitle")}>
        <div data-testid="settings-git-worktree-max-count-row">
          <SectionRow
            label={tSettings("editor.git.worktreeMaxCount")}
            description={tSettings("editor.git.worktreeMaxCountDesc")}
          >
            <Select
              value={worktreeMaxCount}
              size="default"
              onChange={(value) => setWorktreeMaxCount(Number(value))}
              options={WORKTREE_MAX_COUNT_OPTIONS}
              style={SECTION_CONTROL_STYLE}
              dataTestId="settings-git-worktree-max-count-select"
            />
          </SectionRow>
        </div>

        <div data-testid="settings-git-worktree-cleanup-interval-row">
          <SectionRow
            label={tSettings("editor.git.worktreeCleanupInterval")}
            description={tSettings("editor.git.worktreeCleanupIntervalDesc")}
          >
            <Select
              value={worktreeCleanupIntervalHours}
              size="default"
              onChange={(value) =>
                setWorktreeCleanupIntervalHours(Number(value))
              }
              options={WORKTREE_CLEANUP_INTERVAL_OPTIONS.map((interval) => ({
                label: tSettings(interval.labelKey),
                value: interval.value,
                dataTestId: interval.dataTestId,
              }))}
              style={SECTION_CONTROL_STYLE}
              dataTestId="settings-git-worktree-cleanup-interval-select"
            />
          </SectionRow>
        </div>
      </SectionContainer>

      <SectionContainer title={tSettings("editor.git.gitProxyLink")}>
        <SectionRow label={tSettings("monitor.gitProxyHttp")}>
          <Input
            value={proxyHttpDraft}
            onChange={setProxyHttpDraft}
            placeholder="http://proxy.example.com:8080"
            size="default"
            style={SECTION_CONTROL_STYLE}
            disabled={proxySaving}
          />
        </SectionRow>

        <SectionRow label={tSettings("monitor.gitProxyHttps")}>
          <Input
            value={proxyHttpsDraft}
            onChange={setProxyHttpsDraft}
            placeholder="http://proxy.example.com:8080"
            size="default"
            style={SECTION_CONTROL_STYLE}
            disabled={proxySaving}
          />
        </SectionRow>

        {proxyInfo?.source === "environment" && (
          <SectionRow showHeader={false} className="!min-h-0 !py-0">
            <p className="text-[11px] text-text-3">
              {tSettings("monitor.gitProxyEnvNote")}
            </p>
          </SectionRow>
        )}

        {(proxyInfo?.http_proxy || proxyInfo?.https_proxy) && !proxyDirty && (
          <SectionRow showHeader={false}>
            <Button
              variant="tertiary"
              size="default"
              icon={
                <HugeiconsIcon
                  icon={Delete02Icon}
                  data-icon="trash-2"
                  size={14}
                  className="text-danger-6"
                />
              }
              onClick={handleProxyClear}
              loading={proxySaving}
              disabled={proxySaving}
              className="self-start"
            >
              {tSettings("monitor.gitProxyClear")}
            </Button>
          </SectionRow>
        )}

        {proxyDirty && (
          <SectionRow showHeader={false}>
            <div className="flex w-full justify-end">
              <div className={SECTION_ACTION_GAP_CLASSES}>
                <Button
                  size="default"
                  onClick={handleProxyCancel}
                  disabled={proxySaving}
                >
                  {tCommon("actions.cancel")}
                </Button>
                <Button
                  variant="primary"
                  size="default"
                  loading={proxySaving}
                  disabled={proxySaving}
                  onClick={handleProxySave}
                >
                  {tCommon("actions.save")}
                </Button>
              </div>
            </div>
          </SectionRow>
        )}
      </SectionContainer>

      <SectionContainer title={t("git.attributionTitle")}>
        <SectionRow
          label={t("git.commitAttribution")}
          description={t("git.commitAttributionDesc", {
            name: ORGII_COAUTHOR_NAME,
            email: ORGII_COAUTHOR_EMAIL,
          })}
        >
          <Switch
            checked={coauthorAttributionEnabled}
            onCheckedChange={setCoauthorAttributionEnabled}
          />
        </SectionRow>

        <SectionRow
          label={t("git.prAttribution")}
          description={t("git.prAttributionDesc", {
            name: ORGII_COAUTHOR_NAME,
            email: ORGII_COAUTHOR_EMAIL,
          })}
        >
          <Switch
            checked={prAttributionEnabled}
            onCheckedChange={setPrAttributionEnabled}
          />
        </SectionRow>
      </SectionContainer>
    </>
  );
};

export default GitPreferencesSection;
