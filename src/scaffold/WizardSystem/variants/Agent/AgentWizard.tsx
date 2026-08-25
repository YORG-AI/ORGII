/**
 * AgentWizard — wizard for creating/configuring a custom agent.
 *
 * Used from:
 * 1. The "Agents" tab (full-page via WizardShell)
 * 2. The AgentTeamWizard "+ Add agent" action (as a modal overlay)
 *
 * Tabs: Core | Models | Sub-Agents. Personality (`soulContent`) lives at the top of Core.
 *
 * Tools / MCP / Skills / Rules editors live on the per-agent detail view
 * (where each section can be wired to the actual agent id). The wizard
 * intentionally omits them so a custom-agent edit cannot silently rewrite
 * OS or SDE Agent state via OS/SDE-bound hooks.
 *
 * State and form logic live in useAgentWizard.ts.
 */
import { type FC, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import NumberInput from "@src/components/NumberInput";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import TabPill from "@src/components/TabPill";
import Textarea from "@src/components/Textarea";
import SubAgentsEditor from "@src/modules/MainApp/AgentOrgs/config/shared/SubAgentsEditor";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import MarkdownEditor from "@src/modules/shared/components/MarkdownEditor";
import {
  SECTION_DESCRIPTION_CLASSES,
  SECTION_GAP_CLASSES,
  SECTION_LABEL_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { SECTION_CONTROL_STYLE } from "@src/modules/shared/layouts/SectionLayout/tokens";
import {
  DETAIL_PANEL_TOKENS,
  InternalHeader,
} from "@src/modules/shared/layouts/blocks";
import {
  WizardShell,
  WizardStepLayout,
} from "@src/scaffold/WizardSystem/primitives";

import { useAgentWizard } from "./useAgentWizard";

interface AgentWizardProps {
  onSave: (agent: AgentDefinition) => void | Promise<void>;
  onCancel: () => void;
}

function onChangeIfDefined<T>(setter: (val: T) => void) {
  return (val: T | undefined) => {
    if (val !== undefined) setter(val);
  };
}

const AgentWizard: FC<AgentWizardProps> = ({ onSave, onCancel }) => {
  const { t } = useTranslation("integrations");
  const { t: tSettings } = useTranslation("settings");
  const w = useAgentWizard(onSave);

  const headerTabs = useMemo(
    () => (
      <TabPill
        tabs={w.tabs}
        activeTab={w.activeTab}
        onChange={w.setActiveTab}
        variant="simple"
        fillWidth={false}
        size="large"
      />
    ),
    [w.tabs, w.activeTab, w.setActiveTab]
  );

  const afterHeader = useMemo(
    () => (
      <InternalHeader
        contentPadding
        className={DETAIL_PANEL_TOKENS.headerWidth}
        tabs={headerTabs}
      />
    ),
    [headerTabs]
  );

  const soulEditorTabs = useMemo(
    () => (
      <TabPill
        tabs={w.editorTabs}
        activeTab={w.soulTab}
        onChange={w.setSoulTab}
        variant="pill"
        fillWidth={false}
      />
    ),
    [w.editorTabs, w.soulTab, w.setSoulTab]
  );

  return (
    <WizardShell
      title={t("agentOrgs.agentWizard.title")}
      onCancel={onCancel}
      testId="agent-orgs-agent-wizard-root"
      afterHeader={afterHeader}
    >
      <WizardStepLayout
        currentStep={1}
        totalSteps={1}
        fillWidth
        noPadding
        hideStepIndicator
        contentWidthFooter
        actions={
          <>
            <Button
              variant="secondary"
              size="small"
              data-testid="agent-orgs-agent-wizard-cancel-button"
              onClick={onCancel}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="primary"
              size="small"
              disabled={!w.canCreate}
              data-testid="agent-orgs-agent-wizard-create-button"
              onClick={w.handleCreate}
            >
              {t("common:actions.create")}
            </Button>
          </>
        }
      >
        {w.activeTab === "core" && (
          <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
            <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
              <div className={SECTION_GAP_CLASSES}>
                <SectionContainer>
                  <SectionRow
                    label={t("agentOrgs.agentWizard.nameLabel")}
                    description={t("agentOrgs.agentWizard.nameDesc")}
                  >
                    <Input
                      value={w.agentName}
                      onChange={w.setAgentName}
                      placeholder={t("agentOrgs.agentWizard.namePlaceholder")}
                      data-testid="agent-orgs-agent-wizard-name-input"
                      size="default"
                      style={SECTION_CONTROL_STYLE}
                      autoFocus
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                  </SectionRow>
                  <SectionRow
                    label={t("agentOrgs.agentWizard.descriptionLabel")}
                    description={t("agentOrgs.agentWizard.descriptionDesc")}
                    layout="vertical"
                  >
                    <Textarea
                      value={w.description}
                      onChange={w.setDescription}
                      placeholder={t(
                        "agentOrgs.agentWizard.descriptionPlaceholder"
                      )}
                      data-testid="agent-orgs-agent-wizard-description-input"
                      autoSize={{ minRows: 3, maxRows: 6 }}
                    />
                  </SectionRow>
                </SectionContainer>

                <SectionContainer>
                  <div className="flex flex-col gap-2 py-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className={SECTION_LABEL_CLASSES}>
                          {tSettings("sharedAgentConfig.personality.label")}
                        </div>
                        <div className={SECTION_DESCRIPTION_CLASSES}>
                          {tSettings(
                            "sharedAgentConfig.personality.description"
                          )}
                        </div>
                      </div>
                      {soulEditorTabs}
                    </div>
                    <MarkdownEditor
                      value={w.soulContent}
                      onChange={w.setSoulContent}
                      dataTestId="agent-orgs-agent-wizard-soul-editor"
                      emptyLineCount={10}
                      hideHeader
                      activeTab={w.soulTab}
                      onTabChange={w.setSoulTab}
                    />
                  </div>
                </SectionContainer>
              </div>
            </div>
          </div>
        )}

        {w.activeTab === "models" && (
          <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
            <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
              <div className={SECTION_GAP_CLASSES}>
                <SectionContainer>
                  <SectionRow
                    label={tSettings("sharedAgentConfig.contextWindow")}
                    description={
                      w.isCustomContextWindow
                        ? tSettings("sharedAgentConfig.contextWindowCustomDesc")
                        : tSettings("sharedAgentConfig.contextWindowAuto")
                    }
                  >
                    <Select
                      value={w.isCustomContextWindow ? "custom" : "auto"}
                      options={w.contextWindowOptions}
                      onChange={(val) =>
                        w.setContextWindow(val === "auto" ? 0 : 128000)
                      }
                      style={SECTION_CONTROL_STYLE}
                      dataTestId="agent-orgs-agent-wizard-context-window-select"
                    />
                  </SectionRow>
                  {w.isCustomContextWindow && (
                    <SectionRow label="" description="" indent>
                      <NumberInput
                        value={w.contextWindow}
                        onValueChange={onChangeIfDefined(w.setContextWindow)}
                        min={16000}
                        step={1000}
                        controlsPosition="sides"
                        style={SECTION_CONTROL_STYLE}
                        dataTestId="agent-orgs-agent-wizard-context-window-input"
                      />
                    </SectionRow>
                  )}
                  <SectionRow
                    label={tSettings("sharedAgentConfig.maxTokens")}
                    description={tSettings("sharedAgentConfig.maxTokensDesc")}
                  >
                    <NumberInput
                      value={w.maxTokens}
                      onValueChange={onChangeIfDefined(w.setMaxTokens)}
                      min={256}
                      max={65536}
                      step={256}
                      controlsPosition="sides"
                      style={SECTION_CONTROL_STYLE}
                      dataTestId="agent-orgs-agent-wizard-max-tokens-input"
                    />
                  </SectionRow>
                  <SectionRow
                    label={tSettings("sharedAgentConfig.temperature")}
                    description={tSettings("sharedAgentConfig.temperatureDesc")}
                  >
                    <NumberInput
                      value={w.temperature}
                      onValueChange={onChangeIfDefined(w.setTemperature)}
                      min={0}
                      max={2}
                      step={0.1}
                      controlsPosition="sides"
                      style={SECTION_CONTROL_STYLE}
                      dataTestId="agent-orgs-agent-wizard-temperature-input"
                    />
                  </SectionRow>
                </SectionContainer>
                <SectionContainer>
                  <SectionRow
                    label={tSettings("sharedAgentConfig.compactionEnabled")}
                    description={tSettings(
                      "sharedAgentConfig.compactionEnabledDesc"
                    )}
                  >
                    <Switch
                      checked={w.compactionEnabled}
                      dataTestId="agent-orgs-agent-wizard-compaction-enabled-switch"
                      onCheckedChange={w.setCompactionEnabled}
                    />
                  </SectionRow>
                  {w.compactionEnabled && (
                    <>
                      <SectionRow
                        label={tSettings(
                          "sharedAgentConfig.compactionTriggerRatio"
                        )}
                        description={tSettings(
                          "sharedAgentConfig.compactionTriggerRatioDesc"
                        )}
                        indent
                      >
                        <NumberInput
                          value={w.compactionTriggerRatio}
                          onValueChange={onChangeIfDefined(
                            w.setCompactionTriggerRatio
                          )}
                          min={0.1}
                          max={1.0}
                          step={0.05}
                          controlsPosition="sides"
                          style={SECTION_CONTROL_STYLE}
                          dataTestId="agent-orgs-agent-wizard-compaction-trigger-ratio-input"
                        />
                      </SectionRow>
                      <SectionRow
                        label={tSettings(
                          "sharedAgentConfig.compactionKeepRatio"
                        )}
                        description={tSettings(
                          "sharedAgentConfig.compactionKeepRatioDesc"
                        )}
                        indent
                      >
                        <NumberInput
                          value={w.compactionKeepRatio}
                          onValueChange={onChangeIfDefined(
                            w.setCompactionKeepRatio
                          )}
                          min={0.1}
                          max={0.9}
                          step={0.05}
                          controlsPosition="sides"
                          style={SECTION_CONTROL_STYLE}
                          dataTestId="agent-orgs-agent-wizard-compaction-keep-ratio-input"
                        />
                      </SectionRow>
                      <SectionRow
                        label={tSettings("sharedAgentConfig.compactionModel")}
                        description={tSettings(
                          "sharedAgentConfig.compactionModelDescFallback"
                        )}
                        indent
                      >
                        <Input
                          value={w.compactionModel}
                          onChange={w.setCompactionModel}
                          placeholder={tSettings(
                            "sharedAgentConfig.compactionModelPlaceholder"
                          )}
                          style={SECTION_CONTROL_STYLE}
                          data-testid="agent-orgs-agent-wizard-compaction-model-input"
                        />
                      </SectionRow>
                      <SectionRow
                        label={tSettings(
                          "sharedAgentConfig.compactionSummaryMaxTokens"
                        )}
                        description={tSettings(
                          "sharedAgentConfig.compactionSummaryMaxTokensDesc"
                        )}
                        indent
                      >
                        <NumberInput
                          value={w.compactionSummaryMaxTokens}
                          onValueChange={onChangeIfDefined(
                            w.setCompactionSummaryMaxTokens
                          )}
                          min={512}
                          step={256}
                          controlsPosition="sides"
                          style={SECTION_CONTROL_STYLE}
                          dataTestId="agent-orgs-agent-wizard-compaction-summary-max-tokens-input"
                        />
                      </SectionRow>
                      <SectionRow
                        label={tSettings(
                          "sharedAgentConfig.compactionMinMessages"
                        )}
                        description={tSettings(
                          "sharedAgentConfig.compactionMinMessagesDesc"
                        )}
                        indent
                      >
                        <NumberInput
                          value={w.compactionMinMessages}
                          onValueChange={onChangeIfDefined(
                            w.setCompactionMinMessages
                          )}
                          min={1}
                          max={50}
                          step={1}
                          controlsPosition="sides"
                          style={SECTION_CONTROL_STYLE}
                          dataTestId="agent-orgs-agent-wizard-compaction-min-messages-input"
                        />
                      </SectionRow>
                      <SectionRow
                        label={tSettings(
                          "sharedAgentConfig.compactionFloorTokens"
                        )}
                        description={tSettings(
                          "sharedAgentConfig.compactionFloorTokensDesc"
                        )}
                        indent
                      >
                        <NumberInput
                          value={w.compactionFloorTokens}
                          onValueChange={onChangeIfDefined(
                            w.setCompactionFloorTokens
                          )}
                          min={4000}
                          step={1000}
                          controlsPosition="sides"
                          style={SECTION_CONTROL_STYLE}
                          dataTestId="agent-orgs-agent-wizard-compaction-floor-tokens-input"
                        />
                      </SectionRow>
                      <SectionRow
                        label={tSettings(
                          "sharedAgentConfig.compactionReservedSummaryTokens"
                        )}
                        description={tSettings(
                          "sharedAgentConfig.compactionReservedSummaryTokensDesc"
                        )}
                        indent
                      >
                        <NumberInput
                          value={w.compactionReservedSummaryTokens}
                          onValueChange={onChangeIfDefined(
                            w.setCompactionReservedSummaryTokens
                          )}
                          min={1000}
                          step={1000}
                          controlsPosition="sides"
                          style={SECTION_CONTROL_STYLE}
                          dataTestId="agent-orgs-agent-wizard-compaction-reserved-summary-tokens-input"
                        />
                      </SectionRow>
                      <SectionRow
                        label={tSettings(
                          "sharedAgentConfig.compactionBufferTokens"
                        )}
                        description={tSettings(
                          "sharedAgentConfig.compactionBufferTokensDesc"
                        )}
                        indent
                      >
                        <NumberInput
                          value={w.compactionBufferTokens}
                          onValueChange={onChangeIfDefined(
                            w.setCompactionBufferTokens
                          )}
                          min={0}
                          step={1000}
                          controlsPosition="sides"
                          style={SECTION_CONTROL_STYLE}
                          dataTestId="agent-orgs-agent-wizard-compaction-buffer-tokens-input"
                        />
                      </SectionRow>
                    </>
                  )}
                </SectionContainer>
              </div>
            </div>
          </div>
        )}

        {w.activeTab === "capabilities" && (
          <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
            <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
              <div className={SECTION_GAP_CLASSES}>
                <SectionContainer>
                  <div className="flex flex-col gap-2 py-3">
                    <div className={SECTION_LABEL_CLASSES}>
                      {tSettings("sharedAgentConfig.capabilities.title")}
                    </div>
                    <div className={SECTION_DESCRIPTION_CLASSES}>
                      {tSettings("sharedAgentConfig.capabilities.description")}
                    </div>
                  </div>
                  <SectionRow
                    label={tSettings("sharedAgentConfig.capabilities.coding")}
                    description={tSettings(
                      "sharedAgentConfig.capabilities.codingDesc"
                    )}
                  >
                    <Switch
                      checked={w.capCoding}
                      dataTestId="agent-orgs-agent-wizard-capability-coding-switch"
                      onCheckedChange={w.setCapCoding}
                    />
                  </SectionRow>
                  {w.capCoding && (
                    <SectionRow
                      label={tSettings(
                        "sharedAgentConfig.capabilities.codingModeSwitch"
                      )}
                      description={tSettings(
                        "sharedAgentConfig.capabilities.codingModeSwitchDesc"
                      )}
                      indent
                    >
                      <Switch
                        checked={w.capCodingModeSwitch}
                        dataTestId="agent-orgs-agent-wizard-capability-coding-mode-switch"
                        onCheckedChange={w.setCapCodingModeSwitch}
                      />
                    </SectionRow>
                  )}
                  <SectionRow
                    label={tSettings("sharedAgentConfig.capabilities.desktop")}
                    description={tSettings(
                      "sharedAgentConfig.capabilities.desktopDesc"
                    )}
                  >
                    <Switch
                      checked={w.capDesktop}
                      dataTestId="agent-orgs-agent-wizard-capability-desktop-switch"
                      onCheckedChange={w.setCapDesktop}
                    />
                  </SectionRow>
                  <SectionRow
                    label={tSettings(
                      "sharedAgentConfig.capabilities.browserExternal"
                    )}
                    description={tSettings(
                      "sharedAgentConfig.capabilities.browserExternalDesc"
                    )}
                  >
                    <Switch
                      checked={w.capBrowserExternal}
                      dataTestId="agent-orgs-agent-wizard-capability-browser-external-switch"
                      onCheckedChange={w.setCapBrowserExternal}
                    />
                  </SectionRow>
                  <SectionRow
                    label={tSettings(
                      "sharedAgentConfig.capabilities.browserInternal"
                    )}
                    description={tSettings(
                      "sharedAgentConfig.capabilities.browserInternalDesc"
                    )}
                  >
                    <Switch
                      checked={w.capBrowserInternal}
                      dataTestId="agent-orgs-agent-wizard-capability-browser-internal-switch"
                      onCheckedChange={w.setCapBrowserInternal}
                    />
                  </SectionRow>
                  <SectionRow
                    label={tSettings("sharedAgentConfig.capabilities.gateway")}
                    description={tSettings(
                      "sharedAgentConfig.capabilities.gatewayDesc"
                    )}
                  >
                    <Switch
                      checked={w.capGateway}
                      dataTestId="agent-orgs-agent-wizard-capability-gateway-switch"
                      onCheckedChange={w.setCapGateway}
                    />
                  </SectionRow>
                  <SectionRow
                    label={tSettings("sharedAgentConfig.capabilities.data")}
                    description={tSettings(
                      "sharedAgentConfig.capabilities.dataDesc"
                    )}
                  >
                    <Switch
                      checked={w.capData}
                      dataTestId="agent-orgs-agent-wizard-capability-data-switch"
                      onCheckedChange={w.setCapData}
                    />
                  </SectionRow>
                  <SectionRow
                    label={tSettings(
                      "sharedAgentConfig.capabilities.management"
                    )}
                    description={tSettings(
                      "sharedAgentConfig.capabilities.managementDesc"
                    )}
                  >
                    <Switch
                      checked={w.capManagement}
                      dataTestId="agent-orgs-agent-wizard-capability-management-switch"
                      onCheckedChange={w.setCapManagement}
                    />
                  </SectionRow>
                </SectionContainer>
              </div>
            </div>
          </div>
        )}

        {w.activeTab === "subagents" && (
          <div className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
            <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
              <SubAgentsEditor
                subAgents={w.subAgents}
                onChange={w.setSubAgents}
                maxToolUseConcurrency={w.maxToolUseConcurrency}
                onMaxToolUseConcurrencyChange={w.setMaxToolUseConcurrency}
                t={t}
              />
            </div>
          </div>
        )}
      </WizardStepLayout>
    </WizardShell>
  );
};

export default AgentWizard;
