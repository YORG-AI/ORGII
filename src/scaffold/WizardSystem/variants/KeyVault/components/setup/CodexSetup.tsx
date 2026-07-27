import { Keyboard, LogIn, ScanSearch } from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import { CodexSessionSetup } from "@src/features/SessionSetup";
import {
  SECTION_CONTROL_STYLE,
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  type SelectionGridOption,
} from "@src/scaffold/WizardSystem/primitives";

import type { CodexSetupProps } from "./types";

type CodexMethod = "signin" | "autodetect" | "enter_token";

const CodexSetup: React.FC<CodexSetupProps> = ({
  data,
  onChange,
  keyValidated,
  validatingKey,
  validationError,
  validateKey,
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
  autoStartLogin = false,
}) => {
  const { t } = useTranslation("integrations");

  const methodOptions: SelectionGridOption<CodexMethod>[] = useMemo(
    () => [
      { key: "signin", label: t("keyVault.signIn"), icon: LogIn },
      {
        key: "autodetect",
        label: t("keyVault.autodetect"),
        icon: ScanSearch,
      },
      {
        key: "enter_token",
        label: t("keyVault.enterToken"),
        icon: Keyboard,
      },
    ],
    [t]
  );

  const selectedMethod = (data.setup_method ?? "signin") as CodexMethod;
  const hideSelector = !!preselectedMethod;

  const handleCredentialChange = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      const looksLikeOAuthToken = trimmed.startsWith("eyJ");
      onChange({
        raw_key_input: value,
        oauth_session_token: looksLikeOAuthToken ? value : "",
        auth_method: looksLikeOAuthToken
          ? "oauth"
          : trimmed
            ? "api_key"
            : undefined,
        validated: false,
      });
    },
    [onChange]
  );

  const handleValidateManualCredential = useCallback(() => {
    void validateKey();
  }, [validateKey]);

  return (
    <div
      className={
        browserOpen
          ? "flex h-full min-h-0 flex-1 flex-col"
          : SECTION_GAP_CLASSES
      }
      data-testid="codex-setup"
    >
      {!hideSelector && !browserOpen && (
        <SectionContainer>
          <SectionRow
            label={t("keyVault.setupMethod")}
            description={t("keyVault.codexSetupMethodDesc")}
            layout="vertical"
            required
          >
            <SelectionGrid
              options={methodOptions}
              selected={selectedMethod}
              cardVariant="subtle"
              onSelect={(key) => onChange({ setup_method: key })}
            />
          </SectionRow>
        </SectionContainer>
      )}

      {selectedMethod === "signin" && (
        <CodexSessionSetup
          tokenDetected={tokenDetected}
          tokenError={tokenError}
          onClearTokenError={onClearTokenError}
          onSessionCaptured={onSessionCaptured}
          onBrowserStateChange={setBrowserOpen}
          closeSignal={browserCloseSignal}
          autoStart={autoStartLogin}
        />
      )}

      {selectedMethod === "autodetect" && (
        <SectionContainer>
          <SectionRow
            label={t("keyVault.codexAutodetectTitle")}
            description={t("keyVault.codexAutodetectDesc")}
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
              data-testid="codex-autodetect"
            >
              {tokenDetected
                ? `✓ ${t("keyVault.detected")}`
                : t("keyVault.detect")}
            </Button>
          </SectionRow>
        </SectionContainer>
      )}

      {selectedMethod === "enter_token" && (
        <SectionContainer>
          <SectionRow
            label={t("keyVault.codexCredentialLabel")}
            description={t("keyVault.codexCredentialDesc")}
            required
          >
            <div className="flex w-full gap-2">
              <Input
                value={data.oauth_session_token || data.raw_key_input}
                onChange={handleCredentialChange}
                placeholder={t("keyVault.codexCredentialPlaceholder")}
                size="default"
                type="password"
                style={{ ...SECTION_CONTROL_STYLE, flex: 1 }}
              />
              <Button
                variant={keyValidated ? "success" : "primary"}
                appearance={keyValidated ? "outline" : undefined}
                size="default"
                loading={validatingKey}
                disabled={validatingKey}
                onClick={handleValidateManualCredential}
                className="h-8 min-h-8"
              >
                {keyValidated
                  ? `✓ ${t("keyVault.validated")}`
                  : t("keyVault.validate")}
              </Button>
            </div>
          </SectionRow>
        </SectionContainer>
      )}

      {(tokenDetected || data.validated) && selectedMethod !== "signin" && (
        <InlineAlert type="success">{t("keyVault.codexConnected")}</InlineAlert>
      )}

      {tokenError && selectedMethod !== "signin" && (
        <InlineAlert
          type="danger"
          title={tokenError}
          onClose={onClearTokenError}
        >
          {t("keyVault.codexDetectErrorHint")}
        </InlineAlert>
      )}

      {validationError && selectedMethod === "enter_token" && (
        <InlineAlert type="danger" title={validationError}>
          {t("keyVault.codexValidationErrorHint")}
        </InlineAlert>
      )}
    </div>
  );
};

export { CodexSetup };
