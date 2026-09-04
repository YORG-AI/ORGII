import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { ClaudeCodeSessionSetup } from "@src/features/SessionSetup";
import { Login01Icon, SearchAreaIcon } from "@src/icons";
import {
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  type SelectionGridOption,
} from "@src/scaffold/WizardSystem/primitives";

import type { ClaudeCodeSetupProps } from "./types";

type ClaudeCodeMethod = "signin" | "autodetect";

const ClaudeCodeSetup: React.FC<ClaudeCodeSetupProps> = ({
  data,
  onChange,
  tokenDetected,
  detectingToken,
  tokenError,
  onDetectToken,
  onClearTokenError,
  onSessionCaptured,
  preselectedMethod,
  browserOpen,
  setBrowserOpen,
  browserCloseSignal,
}) => {
  const { t } = useTranslation("integrations");

  const methodOptions: SelectionGridOption<ClaudeCodeMethod>[] = useMemo(
    () => [
      { key: "signin", label: t("keyVault.signIn"), icon: Login01Icon },
      {
        key: "autodetect",
        label: t("keyVault.autodetect"),
        icon: SearchAreaIcon,
      },
    ],
    [t]
  );

  const selectedMethod = (data.setup_method ?? "signin") as ClaudeCodeMethod;
  const hideSelector = !!preselectedMethod;

  return (
    <div
      className={
        browserOpen
          ? "flex h-full min-h-0 flex-1 flex-col"
          : SECTION_GAP_CLASSES
      }
      data-testid="claude-code-setup"
    >
      {!hideSelector && !browserOpen && (
        <SectionContainer>
          <SectionRow
            label={t("keyVault.setupMethod")}
            description={t("keyVault.claudeCodeSetupMethodDesc")}
            layout="vertical"
            required
          >
            <SelectionGrid
              options={methodOptions}
              selected={selectedMethod}
              cardVariant="subtle"
              compactCards
              onSelect={(key) => onChange({ setup_method: key })}
            />
          </SectionRow>
        </SectionContainer>
      )}

      {selectedMethod === "signin" && (
        <ClaudeCodeSessionSetup
          tokenDetected={tokenDetected}
          tokenError={tokenError}
          onClearTokenError={onClearTokenError}
          onSessionCaptured={onSessionCaptured}
          onBrowserStateChange={setBrowserOpen}
          closeSignal={browserCloseSignal}
        />
      )}

      {selectedMethod === "autodetect" && (
        <SectionContainer>
          <SectionRow
            label={t("keyVault.claudeCodeAutodetectTitle")}
            description={t("keyVault.claudeCodeAutodetectDesc")}
            required
          >
            <Button
              variant={tokenDetected ? "success" : "primary"}
              appearance={tokenDetected ? "outline" : undefined}
              size="default"
              loading={detectingToken}
              disabled={detectingToken}
              onClick={onDetectToken}
              className="h-8 min-h-8"
              data-testid="claude-code-autodetect"
            >
              {tokenDetected
                ? `✓ ${t("keyVault.detected")}`
                : t("keyVault.detect")}
            </Button>
          </SectionRow>
        </SectionContainer>
      )}

      {(tokenDetected || data.validated) && selectedMethod !== "signin" && (
        <InlineAlert type="success">
          {t("keyVault.claudeCodeConnected")}
        </InlineAlert>
      )}

      {tokenError && selectedMethod !== "signin" && (
        <InlineAlert
          type="danger"
          title={tokenError}
          onClose={onClearTokenError}
        >
          {t("keyVault.claudeCodeDetectErrorHint")}
        </InlineAlert>
      )}
    </div>
  );
};

export { ClaudeCodeSetup };
