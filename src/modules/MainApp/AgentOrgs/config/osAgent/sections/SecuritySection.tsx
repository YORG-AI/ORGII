/**
 * OS Agent Security Section
 *
 * Surfaces the per-agent fields that exist on the backend `AgentPolicy`
 * struct: autonomy, workspace-only restriction, blocked-command blacklist,
 * forbidden paths, and medium/high command risk rules. Confirmation commands
 * and the security-list master switch are policy
 * invariants filled in by `AgentPolicy::to_runtime_security`.
 *
 * Returns content only — parent wraps in SectionHeading.
 */
import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import SaveableTextarea from "@src/modules/shared/components/SaveableTextarea";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { getNestedBool, getNestedString, getNestedStringArray } from "../utils";

interface SecuritySectionProps {
  config: Record<string, unknown>;
  update: (path: string, value: unknown) => void;
  /** Optional sub-section title above the first container */
  title?: string;
  /** Lock built-in Rust agents to read + write access. */
  accessModeEditable?: boolean;
  /**
   * Hide the "Workspace Only" toggle. Required for the OS Agent because
   * its working_dir is the personal workspace; locking file/shell ops to
   * that directory blocks the agent from touching user repos. The toggle
   * is meaningful for SDE / Custom agents whose working_dir tracks the
   * active session repo.
   */
  hideWorkspaceRestriction?: boolean;
}

const ACCESS_MODE_OPTIONS = [
  {
    labelKey: "sharedAgentConfig.security.accessModeReadOnly",
    value: "readonly",
    dataTestId: "agent-orgs-security-access-mode-option-readonly",
  },
  {
    labelKey: "sharedAgentConfig.security.accessModeReadWrite",
    value: "full",
    dataTestId: "agent-orgs-security-access-mode-option-full",
  },
];

function parseLines(val: string): string[] {
  return val
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

function uniqueLines(values: string[]): string[] {
  return Array.from(new Set(values));
}

function commandRiskRulesFromConfig(config: Record<string, unknown>): {
  medium: string[];
  high: string[];
} {
  const defaults = config._defaultRiskRules;
  if (!defaults || typeof defaults !== "object") {
    return { medium: [], high: [] };
  }
  return {
    medium: getNestedStringArray(config, "_defaultRiskRules.medium"),
    high: getNestedStringArray(config, "_defaultRiskRules.high"),
  };
}

const SecuritySection: React.FC<SecuritySectionProps> = ({
  config,
  update,
  title,
  accessModeEditable = true,
  hideWorkspaceRestriction = false,
}) => {
  const { t } = useTranslation("settings");

  const autonomy = getNestedString(config, "security.autonomy", "full");
  const accessMode = accessModeEditable ? autonomy : "full";
  const workspaceOnly = getNestedBool(config, "security.workspaceOnly", true);
  const blockedCommands = getNestedStringArray(
    config,
    "security.blockedCommands"
  );
  const forbiddenPaths = getNestedStringArray(
    config,
    "security.forbiddenPaths"
  );
  const alwaysAskCommands = getNestedStringArray(
    config,
    "security.riskRules.medium"
  );
  const blockRuleCommands = getNestedStringArray(
    config,
    "security.riskRules.high"
  );
  const blockListCommands = uniqueLines([
    ...blockedCommands,
    ...blockRuleCommands,
  ]);

  const handleSaveBlockList = useCallback(
    (val: string) => {
      update("security.blockedCommands", []);
      update("security.riskRules.high", parseLines(val));
    },
    [update]
  );

  const handleSaveForbiddenPaths = useCallback(
    (val: string) => {
      update("security.forbiddenPaths", parseLines(val));
    },
    [update]
  );

  const handleSaveAlwaysAskList = useCallback(
    (val: string) => {
      update("security.riskRules.medium", parseLines(val));
    },
    [update]
  );

  const handleResetRiskRules = useCallback(() => {
    const defaults = commandRiskRulesFromConfig(config);
    update("security.blockedCommands", []);
    update("security.riskRules", {
      medium: [...defaults.medium],
      high: [...defaults.high],
    });
  }, [config, update]);

  return (
    <div className="flex flex-col gap-4">
      <SectionContainer title={title}>
        <SectionRow label={t("sharedAgentConfig.security.accessMode")}>
          <Select
            value={accessMode}
            onChange={(val) => update("security.autonomy", val as string)}
            options={ACCESS_MODE_OPTIONS.map((opt) => ({
              label: t(opt.labelKey),
              value: opt.value,
              dataTestId: opt.dataTestId,
            }))}
            size="default"
            style={SECTION_CONTROL_STYLE}
            dataTestId="agent-orgs-security-access-mode-select"
            disabled={!accessModeEditable}
          />
        </SectionRow>
        {!hideWorkspaceRestriction && (
          <SectionRow
            label={t("sharedAgentConfig.security.workspaceOnly")}
            description={t("sharedAgentConfig.security.workspaceOnlyDesc")}
          >
            <Switch
              checked={workspaceOnly}
              onCheckedChange={(checked: boolean) =>
                update("security.workspaceOnly", checked)
              }
              dataTestId="agent-orgs-security-workspace-only-switch"
            />
          </SectionRow>
        )}
      </SectionContainer>

      <SectionContainer
        title={t("sharedAgentConfig.security.commandPolicyTitle")}
      >
        <SectionRow
          label={t("sharedAgentConfig.security.blockListCommands")}
          description={t("sharedAgentConfig.security.blockListCommandsDesc")}
          layout="vertical"
        >
          <SaveableTextarea
            value={blockListCommands.join("\n")}
            onSave={handleSaveBlockList}
            placeholder={t(
              "sharedAgentConfig.security.blockListCommandsPlaceholder"
            )}
            dataTestId="agent-orgs-security-block-list-textarea"
            saveButtonDataTestId="agent-orgs-security-block-list-save-button"
          />
        </SectionRow>
        <SectionRow
          label={t("sharedAgentConfig.security.alwaysAskCommands")}
          description={t("sharedAgentConfig.security.alwaysAskCommandsDesc")}
          layout="vertical"
        >
          <SaveableTextarea
            value={alwaysAskCommands.join("\n")}
            onSave={handleSaveAlwaysAskList}
            placeholder={t(
              "sharedAgentConfig.security.alwaysAskCommandsPlaceholder"
            )}
            dataTestId="agent-orgs-security-always-ask-textarea"
            saveButtonDataTestId="agent-orgs-security-always-ask-save-button"
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer title={t("sharedAgentConfig.security.pathPolicyTitle")}>
        <SectionRow
          label={t("sharedAgentConfig.security.forbiddenPaths")}
          description={t("sharedAgentConfig.security.forbiddenPathsDesc")}
          layout="vertical"
        >
          <SaveableTextarea
            value={forbiddenPaths.join("\n")}
            onSave={handleSaveForbiddenPaths}
            placeholder={t(
              "sharedAgentConfig.security.forbiddenPathsPlaceholder"
            )}
            dataTestId="agent-orgs-security-forbidden-paths-textarea"
            saveButtonDataTestId="agent-orgs-security-forbidden-paths-save-button"
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer
        title={t("sharedAgentConfig.security.resetPolicyTitle")}
      >
        <SectionRow
          label={t("sharedAgentConfig.security.resetRiskRules")}
          description={t("sharedAgentConfig.security.resetRiskRulesDesc")}
        >
          <Button
            size="small"
            variant="secondary"
            onClick={handleResetRiskRules}
          >
            {t("sharedAgentConfig.security.resetRiskRules")}
          </Button>
        </SectionRow>
      </SectionContainer>
    </div>
  );
};

export default SecuritySection;
