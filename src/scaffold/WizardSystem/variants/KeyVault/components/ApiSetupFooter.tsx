/**
 * ApiSetupFooter — Step navigation bar + credential selection modal.
 * Extracted from ApiSetup.tsx.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import type { DetectedKey, ModelType } from "@src/api/types/keys";
import Button from "@src/components/Button";
import { HugeiconsIcon, Tick01Icon } from "@src/icons";
import {
  DETAIL_PANEL_TOKENS,
  PANEL_FOOTER_TOKENS,
} from "@src/modules/shared/layouts/blocks";

import KeySelectionModal from "./KeySelectionModal";

interface ApiSetupFooterProps {
  canProceed: boolean;
  onNext: () => void;
  onCancel: () => void;
  /** Whether the pinned section above already has a border-top */
  hasPinnedSection: boolean;
  /** Primary button label (e.g. "Done") */
  submitLabel: string;
  /** Show loading spinner on the primary button */
  loading?: boolean;

  // Cursor guided-mode session token indicator
  showSessionTokenIndicator: boolean;
  // Key selection modal
  showKeySelection: boolean;
  detectedKeys: DetectedKey[];
  /** Provider the detected keys belong to — used to label their endpoints. */
  agentType: ModelType;
  selectedCredentialIndex: number;
  onSelectCredentialIndex: (index: number) => void;
  onConfirmKeySelection: () => void;
  onCloseKeySelection: () => void;
}

const ApiSetupFooter: React.FC<ApiSetupFooterProps> = ({
  canProceed,
  onNext,
  onCancel,
  hasPinnedSection,
  submitLabel,
  loading,
  showSessionTokenIndicator,
  showKeySelection,
  detectedKeys,
  agentType,
  selectedCredentialIndex,
  onSelectCredentialIndex,
  onConfirmKeySelection,
  onCloseKeySelection,
}) => {
  const { t } = useTranslation("integrations");

  return (
    <>
      <div
        className={`${
          !hasPinnedSection
            ? PANEL_FOOTER_TOKENS.container
            : PANEL_FOOTER_TOKENS.containerNoBorder
        } relative z-10 bg-bg-2`}
      >
        <div
          className={`${DETAIL_PANEL_TOKENS.contentWidth} flex items-center justify-between gap-2`}
        >
          <div className="flex items-center gap-3">
            {showSessionTokenIndicator && (
              <div className="flex items-center gap-1.5">
                <HugeiconsIcon
                  icon={Tick01Icon}
                  data-icon="check"
                  size={14}
                  className="text-success-6"
                />
                <span className="text-[12px] text-success-6">
                  {t("keyVault.sessionTokenCaptured")}
                </span>
              </div>
            )}
          </div>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="small"
              onClick={onCancel}
              data-testid="key-vault-wizard-cancel"
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="primary"
              size="small"
              disabled={!canProceed}
              loading={loading}
              onClick={onNext}
              data-testid="key-vault-wizard-submit"
            >
              {submitLabel}
            </Button>
          </div>
        </div>
      </div>

      {showKeySelection && (
        <KeySelectionModal
          keys={detectedKeys}
          agentType={agentType}
          selectedIndex={selectedCredentialIndex}
          onSelectIndex={onSelectCredentialIndex}
          onConfirm={onConfirmKeySelection}
          onClose={onCloseKeySelection}
        />
      )}
    </>
  );
};

export default ApiSetupFooter;
