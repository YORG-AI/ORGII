/**
 * AgentModelsSection — Shared Models tab content for OS / SDE / Custom /
 * Wingman agent detail views.
 *
 * Renders context window, sampling (maxTokens / temperature), compaction,
 * and reliability retry. The per-agent model chain now lives in the shared
 * Models & Keys › Preferred Models tab, not here.
 *
 * `update` must support dotted paths (e.g. `compaction.enabled`); all
 * three `useXxxAgentConfig` hooks already do via `setNested`.
 */
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import NumberInput from "@src/components/NumberInput";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import {
  getNestedBool,
  getNestedNumber,
  getNestedString,
} from "../osAgent/utils";
import ModelPicker from "./ModelPicker";

interface AgentModelsSectionProps {
  config: Record<string, unknown>;
  update: (path: string, value: unknown) => void;
  /** Optional sub-section title above the model chain container */
  title?: string;
}

const CONTEXT_WINDOW_OPTIONS = [
  { label: "", value: "auto" },
  { label: "", value: "custom" },
];

const AgentModelsSection: React.FC<AgentModelsSectionProps> = ({
  config,
  update,
  title,
}) => {
  const { t } = useTranslation("settings");
  const [compactionAdvancedOpen, setCompactionAdvancedOpen] = useState(false);

  const contextWindowRaw =
    "contextWindow" in config ? config.contextWindow : null;
  const contextWindow =
    typeof contextWindowRaw === "number" && contextWindowRaw > 0
      ? contextWindowRaw
      : null;
  const isCustomContextWindow = contextWindow !== null;

  const maxTokens = getNestedNumber(config, "maxTokens", 8192);
  const temperature = getNestedNumber(config, "temperature", 0.7);

  const compactionEnabled = getNestedBool(config, "compaction.enabled", true);
  const compactionTriggerRatio = getNestedNumber(
    config,
    "compaction.triggerRatio",
    0.8
  );
  const compactionKeepRatio = getNestedNumber(
    config,
    "compaction.keepRatio",
    0.4
  );
  const compactionSummaryMaxTokens = getNestedNumber(
    config,
    "compaction.summaryMaxTokens",
    4096
  );
  const compactionMinMessages = getNestedNumber(
    config,
    "compaction.minMessages",
    8
  );
  const compactionFloorTokens = getNestedNumber(
    config,
    "compaction.floorTokens",
    16000
  );
  const compactionModel = getNestedString(config, "compaction.model", "");
  const compactionReservedSummaryTokens = getNestedNumber(
    config,
    "compaction.reservedSummaryTokens",
    20000
  );
  const compactionBufferTokens = getNestedNumber(
    config,
    "compaction.bufferTokens",
    13000
  );

  const reliabilityMaxRetries = getNestedNumber(
    config,
    "reliability.maxRetries",
    2
  );
  // reliability is "enabled" whenever maxRetries >= 1. 0 is the Rust
  // sentinel meaning "disabled". The UI never lets the user type 0
  // directly (min={1} on NumberInput); only the Switch can write 0.
  const reliabilityEnabled = reliabilityMaxRetries > 0;
  const reliabilityBackoffMs = getNestedNumber(
    config,
    "reliability.baseBackoffMs",
    500
  );

  const contextWindowOptions = CONTEXT_WINDOW_OPTIONS.map((opt) => ({
    ...opt,
    label:
      opt.value === "auto"
        ? t("sharedAgentConfig.contextWindowAuto")
        : t("sharedAgentConfig.contextWindowCustom"),
  }));

  return (
    <div className="flex flex-col gap-4">
      <SectionContainer title={title}>
        <SectionRow
          label={t("sharedAgentConfig.contextWindow")}
          description={
            isCustomContextWindow
              ? t("sharedAgentConfig.contextWindowCustomDesc")
              : t("sharedAgentConfig.contextWindowAutoDesc")
          }
        >
          <Select
            value={isCustomContextWindow ? "custom" : "auto"}
            onChange={(val) => {
              if (val === "auto") {
                update("contextWindow", null);
              } else {
                update("contextWindow", 128000);
              }
            }}
            options={contextWindowOptions}
            size="default"
            style={SECTION_CONTROL_STYLE}
          />
        </SectionRow>
        {isCustomContextWindow && (
          <SectionRow
            label={t("sharedAgentConfig.contextWindowCustomTokens")}
            indent
          >
            <NumberInput
              value={contextWindow ?? 128000}
              min={16000}
              step={1000}
              controlsPosition="sides"
              onValueChange={(val) => {
                if (val !== undefined) update("contextWindow", val);
              }}
              style={SECTION_CONTROL_STYLE}
              dataTestId="agent-orgs-model-context-window-input"
            />
          </SectionRow>
        )}
        <SectionRow
          label={t("sharedAgentConfig.maxTokens")}
          description={t("sharedAgentConfig.maxTokensDesc")}
        >
          <NumberInput
            value={maxTokens}
            min={256}
            max={65536}
            step={256}
            controlsPosition="sides"
            onValueChange={(val) => {
              if (val !== undefined) update("maxTokens", val);
            }}
            style={SECTION_CONTROL_STYLE}
            dataTestId="agent-orgs-model-max-tokens-input"
          />
        </SectionRow>
        <SectionRow
          label={t("sharedAgentConfig.temperature")}
          description={t("sharedAgentConfig.temperatureDesc")}
        >
          <NumberInput
            value={temperature}
            min={0}
            max={2}
            step={0.1}
            controlsPosition="sides"
            onValueChange={(val) => {
              if (val !== undefined) update("temperature", val);
            }}
            style={SECTION_CONTROL_STYLE}
            dataTestId="agent-orgs-model-temperature-input"
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <SectionRow
          label={t("sharedAgentConfig.compactionEnabled")}
          description={t("sharedAgentConfig.compactionEnabledDesc")}
        >
          <Switch
            checked={compactionEnabled}
            onCheckedChange={(checked: boolean) => {
              update("compaction.enabled", checked);
              if (!checked) setCompactionAdvancedOpen(false);
            }}
            dataTestId="agent-orgs-model-compaction-enabled-switch"
          />
        </SectionRow>
        <SectionRow
          label={t("sharedAgentConfig.compactionTriggerRatio")}
          description={t("sharedAgentConfig.compactionTriggerRatioDesc")}
          indent
        >
          <NumberInput
            value={compactionTriggerRatio}
            min={0.1}
            max={1.0}
            step={0.05}
            controlsPosition="sides"
            onValueChange={(val) => {
              if (val !== undefined) update("compaction.triggerRatio", val);
            }}
            style={SECTION_CONTROL_STYLE}
            disabled={!compactionEnabled}
            dataTestId="agent-orgs-model-compaction-trigger-ratio-input"
          />
        </SectionRow>
        <SectionRow
          label={t("sharedAgentConfig.compactionModel")}
          description={t("sharedAgentConfig.compactionModelDescFallback")}
          indent
        >
          <div style={SECTION_CONTROL_STYLE}>
            <ModelPicker
              value={compactionModel || null}
              onChange={(val) => update("compaction.model", val)}
              disabled={!compactionEnabled}
            />
          </div>
        </SectionRow>
        <SectionRow
          label={t("common:actions.advanced")}
          description={t("sharedAgentConfig.compactionAdvancedDesc")}
        >
          <Switch
            checked={compactionAdvancedOpen}
            disabled={!compactionEnabled}
            onCheckedChange={setCompactionAdvancedOpen}
            dataTestId="agent-orgs-model-compaction-advanced-switch"
          />
        </SectionRow>
        {compactionAdvancedOpen && compactionEnabled && (
          <>
            <SectionRow
              label={t("sharedAgentConfig.compactionKeepRatio")}
              description={t("sharedAgentConfig.compactionKeepRatioDesc")}
              indent
            >
              <NumberInput
                value={compactionKeepRatio}
                min={0.1}
                max={0.9}
                step={0.05}
                controlsPosition="sides"
                onValueChange={(val) => {
                  if (val !== undefined) update("compaction.keepRatio", val);
                }}
                style={SECTION_CONTROL_STYLE}
                dataTestId="agent-orgs-model-compaction-keep-ratio-input"
              />
            </SectionRow>
            <SectionRow
              label={t("sharedAgentConfig.compactionSummaryMaxTokens")}
              description={t(
                "sharedAgentConfig.compactionSummaryMaxTokensDesc"
              )}
              indent
            >
              <NumberInput
                value={compactionSummaryMaxTokens}
                min={512}
                step={256}
                controlsPosition="sides"
                onValueChange={(val) => {
                  if (val !== undefined)
                    update("compaction.summaryMaxTokens", val);
                }}
                style={SECTION_CONTROL_STYLE}
                dataTestId="agent-orgs-model-compaction-summary-max-tokens-input"
              />
            </SectionRow>
            <SectionRow
              label={t("sharedAgentConfig.compactionMinMessages")}
              description={t("sharedAgentConfig.compactionMinMessagesDesc")}
              indent
            >
              <NumberInput
                value={compactionMinMessages}
                min={1}
                max={50}
                step={1}
                controlsPosition="sides"
                onValueChange={(val) => {
                  if (val !== undefined) update("compaction.minMessages", val);
                }}
                style={SECTION_CONTROL_STYLE}
                dataTestId="agent-orgs-model-compaction-min-messages-input"
              />
            </SectionRow>
            <SectionRow
              label={t("sharedAgentConfig.compactionFloorTokens")}
              description={t("sharedAgentConfig.compactionFloorTokensDesc")}
              indent
            >
              <NumberInput
                value={compactionFloorTokens}
                min={4000}
                step={1000}
                controlsPosition="sides"
                onValueChange={(val) => {
                  if (val !== undefined) update("compaction.floorTokens", val);
                }}
                style={SECTION_CONTROL_STYLE}
                dataTestId="agent-orgs-model-compaction-floor-tokens-input"
              />
            </SectionRow>
            <SectionRow
              label={t("sharedAgentConfig.compactionReservedSummaryTokens")}
              description={t(
                "sharedAgentConfig.compactionReservedSummaryTokensDesc"
              )}
              indent
            >
              <NumberInput
                value={compactionReservedSummaryTokens}
                min={1000}
                step={1000}
                controlsPosition="sides"
                onValueChange={(val) => {
                  if (val !== undefined)
                    update("compaction.reservedSummaryTokens", val);
                }}
                style={SECTION_CONTROL_STYLE}
                dataTestId="agent-orgs-model-compaction-reserved-summary-tokens-input"
              />
            </SectionRow>
            <SectionRow
              label={t("sharedAgentConfig.compactionBufferTokens")}
              description={t("sharedAgentConfig.compactionBufferTokensDesc")}
              indent
            >
              <NumberInput
                value={compactionBufferTokens}
                min={0}
                step={1000}
                controlsPosition="sides"
                onValueChange={(val) => {
                  if (val !== undefined) update("compaction.bufferTokens", val);
                }}
                style={SECTION_CONTROL_STYLE}
                dataTestId="agent-orgs-model-compaction-buffer-tokens-input"
              />
            </SectionRow>
          </>
        )}
      </SectionContainer>

      <SectionContainer>
        <SectionRow
          label={t("sharedAgentConfig.reliability.enabled")}
          description={t("sharedAgentConfig.reliability.enabledDesc")}
        >
          <Switch
            checked={reliabilityEnabled}
            onCheckedChange={(checked: boolean) => {
              if (checked) {
                // Restore to at least 2 retries when enabling; preserve
                // existing value if user had already configured > 0.
                update(
                  "reliability.maxRetries",
                  reliabilityMaxRetries > 0 ? reliabilityMaxRetries : 2
                );
              } else {
                update("reliability.maxRetries", 0);
              }
            }}
            dataTestId="agent-orgs-model-reliability-enabled-switch"
          />
        </SectionRow>
        {reliabilityEnabled && (
          <>
            <SectionRow
              label={t("sharedAgentConfig.reliability.maxRetries")}
              description={t("sharedAgentConfig.reliability.maxRetriesDesc")}
              indent
            >
              <NumberInput
                value={reliabilityMaxRetries}
                min={1}
                max={10}
                step={1}
                controlsPosition="sides"
                onValueChange={(val) => {
                  if (val !== undefined) update("reliability.maxRetries", val);
                }}
                style={SECTION_CONTROL_STYLE}
                dataTestId="agent-orgs-model-reliability-max-retries-input"
              />
            </SectionRow>
            <SectionRow
              label={t("sharedAgentConfig.reliability.baseBackoff")}
              description={t("sharedAgentConfig.reliability.baseBackoffDesc")}
              indent
            >
              <NumberInput
                value={reliabilityBackoffMs}
                min={50}
                max={5000}
                step={50}
                suffix="ms"
                controlsPosition="sides"
                onValueChange={(val) => {
                  if (val !== undefined)
                    update("reliability.baseBackoffMs", val);
                }}
                style={SECTION_CONTROL_STYLE}
                dataTestId="agent-orgs-model-reliability-base-backoff-input"
              />
            </SectionRow>
          </>
        )}
      </SectionContainer>
    </div>
  );
};

export default AgentModelsSection;
