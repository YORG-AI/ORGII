/**
 * CopilotPinnedSection — Pinned token input + validation for Copilot.
 * Extracted from ApiSetup.tsx.
 */
import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

import type { WizardData } from "../types";

interface CopilotPinnedSectionProps {
  data: WizardData;
  onChange: (updates: Partial<WizardData>) => void;
  keyValidated: boolean;
  validatingKey: boolean;
  validationError: string | null;
  validateKey: () => void;
  browserOpen: boolean;
  detectedModelCount: number;
}

const CopilotPinnedSection: React.FC<CopilotPinnedSectionProps> = ({
  data,
  onChange,
  keyValidated,
  validatingKey,
  validationError,
  validateKey,
  browserOpen,
  detectedModelCount,
}) => {
  const { t } = useTranslation("integrations");
  const [successDismissed, setSuccessDismissed] = useState(false);
  const [dismissedError, setDismissedError] = useState<string | null>(null);
  const [instructionsDismissed, setInstructionsDismissed] = useState(false);
  const errorDismissed =
    validationError !== null && validationError === dismissedError;

  return (
    <div className="relative z-10 scrollbar-hide min-h-0 overflow-y-auto border-t border-solid border-border-2 px-4 pt-2">
      <div className={DETAIL_PANEL_TOKENS.contentWidth}>
        {browserOpen && !keyValidated && !instructionsDismissed && (
          <InlineAlert
            type="info"
            title={t("keyVault.copilotHowToCreate")}
            className="mb-2"
            onClose={() => setInstructionsDismissed(true)}
          >
            {t("keyVault.copilotHowToCreateCompact")}
          </InlineAlert>
        )}
        <SectionContainer>
          <SectionRow
            label={t("keyVault.pasteToken")}
            description={t("keyVault.copilotTokenHint")}
            required
          >
            <div className="flex items-center gap-2">
              <Input
                value={data.raw_key_input}
                onChange={(value) => onChange({ raw_key_input: value })}
                placeholder={t("keyVault.copilotTokenPlaceholder")}
                style={SECTION_CONTROL_STYLE}
              />
              <Button
                variant={keyValidated ? "success" : "primary"}
                appearance={keyValidated ? "outline" : undefined}
                size="default"
                loading={validatingKey}
                disabled={validatingKey || !data.raw_key_input}
                onClick={validateKey}
              >
                {keyValidated
                  ? `✓ ${t("keyVault.validated")}`
                  : t("keyVault.validate")}
              </Button>
            </div>
          </SectionRow>
        </SectionContainer>

        {validationError && !browserOpen && !errorDismissed && (
          <InlineAlert
            type="danger"
            className="mt-2"
            onClose={() => setDismissedError(validationError)}
          >
            {validationError}
          </InlineAlert>
        )}

        {keyValidated && !validationError && !successDismissed && (
          <InlineAlert
            type="success"
            className="mt-2"
            onClose={() => setSuccessDismissed(true)}
          >
            {detectedModelCount > 0
              ? t("keyVault.validationSuccessModels", {
                  count: detectedModelCount,
                })
              : t("keyVault.validationSuccessNoModels")}
          </InlineAlert>
        )}
      </div>
    </div>
  );
};

export default CopilotPinnedSection;
