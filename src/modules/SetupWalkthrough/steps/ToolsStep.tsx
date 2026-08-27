import { Check, KeyRound, RefreshCw } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import {
  SECTION_VALUE_TEXT_CLASSES,
  SECTION_VALUE_TEXT_SUCCESS_CLASSES,
  SectionContainer,
  SectionDescription,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { WizardStepContent } from "@src/scaffold/WizardSystem/primitives";

import { ToolsStepIcon } from "../components/SetupStepIcons";
import type { StepProps } from "./types";

const TOOL_LABELS: Record<string, string> = {
  codex: "Codex",
  claude_code: "Claude Code",
  cursor_cli: "Cursor",
};

export const ToolsStep: React.FC<StepProps> = ({ controller }) => {
  const { t } = useTranslation("onboarding");
  const byType = new Map(
    controller.progress.tools.map((tool) => [tool.agentType, tool])
  );
  const isDetecting = controller.activeOperation === "detect-tools";
  const isImporting = controller.activeOperation === "import-history";
  return (
    <WizardStepContent
      title={t("readiness.tools.title")}
      description={t("readiness.tools.description")}
      icon={ToolsStepIcon}
    >
      <SectionContainer>
        {["codex", "claude_code", "cursor_cli"].map((agentType) => {
          const tool = byType.get(
            agentType as "codex" | "claude_code" | "cursor_cli"
          );
          return (
            <SectionRow
              key={agentType}
              label={TOOL_LABELS[agentType]}
              description={t("readiness.tools.detectedDescription")}
            >
              <span
                className={
                  tool?.found
                    ? `inline-flex items-center gap-1.5 ${SECTION_VALUE_TEXT_SUCCESS_CLASSES}`
                    : SECTION_VALUE_TEXT_CLASSES
                }
              >
                {tool?.found && <Check size={14} />}
                {tool
                  ? tool.found
                    ? t("readiness.tools.found", {
                        count: tool.keyCount,
                        validated: tool.validatedCount,
                      })
                    : t("readiness.tools.notFound")
                  : t("readiness.tools.notScanned")}
              </span>
            </SectionRow>
          );
        })}
      </SectionContainer>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={<KeyRound size={15} />}
          loading={isDetecting}
          disabled={controller.activeOperation !== null && !isDetecting}
          onClick={() => void controller.actions.detectTools()}
          data-testid="setup-detect-tools"
        >
          {t("readiness.tools.detect")}
        </Button>
        <Button
          icon={<RefreshCw size={15} />}
          loading={isImporting}
          disabled={controller.activeOperation !== null && !isImporting}
          onClick={() => void controller.actions.importHistory()}
          data-testid="setup-import-codex-history"
        >
          {t("readiness.tools.importHistory")}
        </Button>
      </div>
      {controller.progress.historySessionCount !== null && (
        <InlineAlert type="success" role="status">
          {t("readiness.tools.historyImported", {
            count: controller.progress.historySessionCount,
          })}
        </InlineAlert>
      )}
      <SectionDescription>{t("readiness.tools.privacy")}</SectionDescription>
    </WizardStepContent>
  );
};
