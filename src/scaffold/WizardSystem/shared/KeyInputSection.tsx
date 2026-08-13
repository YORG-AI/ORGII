/**
 * KeyInputSection — Reusable key input with setup method selection.
 *
 * Extracted from GenericSetup for reuse across KeyVaultAccount and Listing wizards.
 * Supports three methods: Autodetect, Enter Key, Extract Config.
 */
import { ClipboardCopy, Keyboard, ScanSearch } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { ModelType } from "@src/api/types/keys";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Textarea from "@src/components/Textarea";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  type SelectionGridOption,
} from "@src/scaffold/WizardSystem/primitives";
import { useProviderConfig } from "@src/scaffold/WizardSystem/variants/KeyVault/config";

// ============================================
// Types
// ============================================

type SetupMethod = "autodetect" | "enter_key" | "extract";

export interface KeyInputSectionProps {
  agentType: ModelType;

  rawKeyInput: string;
  onKeyChange: (value: string) => void;

  keyValidated: boolean;
  validatingKey: boolean;
  onValidate: () => void;

  onAutoDetect?: () => void;
  autoDetecting?: boolean;
  autoDetectError?: string | null;
  onClearAutoDetectError?: () => void;

  validationError?: string | null;

  onExtract?: (rawInput: string, onSuccess?: () => void) => void;
  extracting?: boolean;
  extractError?: string | null;
  onClearExtractError?: () => void;
}

// ============================================
// Component
// ============================================

const KeyInputSection: React.FC<KeyInputSectionProps> = ({
  agentType,
  rawKeyInput,
  onKeyChange,
  keyValidated,
  validatingKey,
  onValidate,
  validationError,
  onAutoDetect,
  autoDetecting,
  autoDetectError,
  onClearAutoDetectError,
  onExtract,
  extracting,
  extractError,
  onClearExtractError,
}) => {
  const { t } = useTranslation("integrations");

  const { config: envConfig, loading: configLoading } =
    useProviderConfig(agentType);

  const [setupMethod, setSetupMethod] = useState<SetupMethod>("autodetect");
  const [rawExtractInput, setRawExtractInput] = useState("");

  const methodOptions = useMemo<SelectionGridOption<SetupMethod>[]>(
    () => [
      {
        key: "autodetect",
        label: t("keyVault.autodetect"),
        icon: ScanSearch,
      },
      { key: "enter_key", label: t("keyVault.enterKey"), icon: Keyboard },
      {
        key: "extract",
        label: t("keyVault.extractConfig"),
        icon: ClipboardCopy,
      },
    ],
    [t]
  );

  const handleMethodChange = useCallback(
    (method: SetupMethod) => {
      if (method === setupMethod) return;
      setSetupMethod(method);
      onKeyChange("");
    },
    [setupMethod, onKeyChange]
  );

  const handleExtractionSuccess = useCallback(() => {
    setSetupMethod("enter_key");
  }, []);

  if (configLoading || !envConfig) {
    return null; // Or a loading spinner
  }

  return (
    <>
      <SectionContainer>
        <SectionRow
          label={t("keyVault.setupMethod")}
          description={t("keyVault.setupMethodDesc")}
          layout="vertical"
          required
        >
          <SelectionGrid
            options={methodOptions}
            selected={setupMethod}
            cardVariant="subtle"
            compactCards
            onSelect={handleMethodChange}
          />
        </SectionRow>
      </SectionContainer>

      {setupMethod === "autodetect" && (
        <>
          <SectionContainer>
            <SectionRow
              label={
                keyValidated
                  ? t("keyVault.apiKeyDetectedFromConfig")
                  : t("keyVault.findApiKeyFromConfig")
              }
              description={t("keyVault.scansEnvAndCliConfig")}
              required
            >
              <Button
                variant={keyValidated ? "success" : "primary"}
                appearance={keyValidated ? "outline" : undefined}
                size="default"
                loading={autoDetecting}
                disabled={autoDetecting}
                onClick={() => onAutoDetect?.()}
                className="h-8 min-h-8"
              >
                {keyValidated
                  ? `✓ ${t("keyVault.detected")}`
                  : t("keyVault.detect")}
              </Button>
            </SectionRow>
          </SectionContainer>
          {autoDetectError && (
            <InlineAlert
              type="danger"
              title={autoDetectError}
              onClose={onClearAutoDetectError}
            >
              {t("keyVault.genericDetectErrorHint")}
            </InlineAlert>
          )}
        </>
      )}

      {setupMethod === "enter_key" && (
        <>
          <SectionContainer>
            <SectionRow
              label={t("keyVault.apiKeyLabel")}
              description={t("keyVault.apiKeyDesc")}
              layout="vertical"
              required
            >
              <Input
                value={rawKeyInput}
                onChange={onKeyChange}
                placeholder={t("keyVault.apiKeyPlaceholder")}
                size="default"
                className="w-full"
              />
            </SectionRow>

            <SectionRow label="" showHeader={false}>
              <Button
                variant={keyValidated ? "success" : "primary"}
                appearance={keyValidated ? "outline" : undefined}
                size="default"
                loading={validatingKey}
                disabled={validatingKey || !rawKeyInput}
                onClick={onValidate}
              >
                {keyValidated
                  ? `✓ ${t("keyVault.validated")}`
                  : t("keyVault.validate")}
              </Button>
            </SectionRow>
          </SectionContainer>
          {validationError && (
            <InlineAlert type="danger" title={validationError} />
          )}
        </>
      )}

      {setupMethod === "extract" && (
        <>
          <SectionContainer>
            <SectionRow
              label={t("keyVault.pasteConfiguration")}
              description={t("keyVault.extractParseHint")}
              layout="vertical"
              required
            >
              <Textarea
                value={rawExtractInput}
                onChange={setRawExtractInput}
                placeholder={t("keyVault.extractPlaceholder", {
                  key: t("keyVault.apiKeyPlaceholder"),
                  urlLine: envConfig.baseUrlEnvVar
                    ? `${envConfig.baseUrlEnvVar} = "${envConfig.defaultBaseUrl || ""}"`
                    : "",
                })}
                rows={5}
                size="small"
              />
              <div className="mt-2 flex justify-start">
                <Button
                  variant="primary"
                  size="default"
                  loading={extracting}
                  disabled={extracting || !rawExtractInput.trim()}
                  onClick={() => {
                    onExtract?.(rawExtractInput, handleExtractionSuccess);
                  }}
                >
                  {extracting
                    ? t("keyVault.extracting")
                    : t("keyVault.extract")}
                </Button>
              </div>
            </SectionRow>
          </SectionContainer>
          {extractError && (
            <InlineAlert
              type="danger"
              title={extractError}
              onClose={onClearExtractError}
            />
          )}
        </>
      )}
    </>
  );
};

export default KeyInputSection;
