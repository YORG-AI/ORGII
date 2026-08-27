/**
 * AgentRuntimeLimitsSection — shared per-agent runtime knobs.
 *
 * Two fields, surfaced identically across OS / SDE / Wingman / Custom:
 * - `maxIterations` (`session_model.maxIterations`) — per-turn tool-call
 *   cap, consumed by the turn processor.
 * - `execTimeout` (top-level on `AgentDefinition`) — shell/subprocess
 *   timeout (seconds), consumed by the Exec tool via
 *   `ResolvedAgent.exec_timeout`. `undefined` = inherit the resolver
 *   default (60s OS / 120s SDE).
 *
 * Both fields use the SAME path that the legacy-blob update path
 * (`extractAgentDefPatch`) and the custom-agent direct path
 * (`useCustomAgentConfig`) translate to the underlying schema.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import NumberInput from "@src/components/NumberInput";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { getNestedNumber } from "../osAgent/utils";

interface AgentRuntimeLimitsSectionProps {
  config: Record<string, unknown>;
  update: (path: string, value: unknown) => void;
  /** Default exec timeout shown when the agent has no explicit override.
   *  60s for OS Agent, 120s for SDE / Custom / Wingman — matches the Rust
   *  resolver default at `ResolvedAgent::resolve`. */
  defaultExecTimeoutSeconds: number;
  /** Default max iterations shown when missing. Matches Rust
   *  `default_max_iterations()` (500). Wingman overrides this in its
   *  builtin definition (30); the value is read from `config` first and
   *  this fallback is only used when the field is unset. */
  defaultMaxIterations?: number;
}

const AgentRuntimeLimitsSection: React.FC<AgentRuntimeLimitsSectionProps> = ({
  config,
  update,
  defaultExecTimeoutSeconds,
  defaultMaxIterations = 500,
}) => {
  const { t } = useTranslation("settings");

  const maxIterations = getNestedNumber(
    config,
    "maxIterations",
    defaultMaxIterations
  );
  const execTimeout = getNestedNumber(
    config,
    "execTimeout",
    defaultExecTimeoutSeconds
  );

  return (
    <SectionContainer>
      <SectionRow
        label={t("sharedAgentConfig.maxIterations")}
        description={t("sharedAgentConfig.maxIterationsDesc")}
      >
        <NumberInput
          value={maxIterations}
          min={1}
          max={500}
          step={1}
          controlsPosition="sides"
          onValueChange={(val) => {
            if (val !== undefined) update("maxIterations", val);
          }}
          style={SECTION_CONTROL_STYLE}
          dataTestId="agent-orgs-runtime-max-iterations-input"
        />
      </SectionRow>
      <SectionRow
        label={t("sharedAgentConfig.execTimeout")}
        description={t("sharedAgentConfig.execTimeoutDesc")}
      >
        <NumberInput
          value={execTimeout}
          min={1}
          max={600}
          step={5}
          suffix={t("common:common.s")}
          controlsPosition="sides"
          onValueChange={(val) => {
            if (val !== undefined) update("execTimeout", val);
          }}
          style={SECTION_CONTROL_STYLE}
          dataTestId="agent-orgs-runtime-exec-timeout-input"
        />
      </SectionRow>
    </SectionContainer>
  );
};

export default AgentRuntimeLimitsSection;
