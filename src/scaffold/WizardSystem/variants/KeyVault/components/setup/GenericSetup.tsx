/**
 * GenericSetup Component
 *
 * Setup UI for generic API key agents (Claude Code, Codex, Gemini CLI, etc.)
 * Uses a flat "Setup Method" selector with three options:
 *   Autodetect | Enter Key | Extract Config
 *
 * Supports:
 * - Autodetect: Find API key from local config files
 * - OAuth: For agents that support OAuth (e.g., Codex with ChatGPT login)
 * - Enter Key: Enter API key directly
 * - Extract Config: Paste messy text, Rust parser extracts the key
 * - Advanced Settings: Custom base URL and env var names
 *
 * Uses SectionContainer + SectionRow + SECTION_GAP_CLASSES.
 */
import { Keyboard, Locate, ScanSearch } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import Textarea from "@src/components/Textarea";
import {
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  type SelectionGridOption,
} from "@src/scaffold/WizardSystem/primitives";

import { useProviderConfig } from "../../config";
import type { AgentSetupProps } from "./types";

type SetupMethod = "autodetect" | "enter_key" | "extract";
type BaseUrlMode = "official" | "custom";

const GenericSetup: FC<AgentSetupProps> = ({
  data,
  onChange,
  keyValidated,
  validatingKey,
  validateKey,
  onInputModeChange,
  onAutoDetect,
  autoDetecting,
  autoDetectError,
  onExtract,
  extracting,
  extractError,
  onClearAutoDetectError,
  onClearExtractError,
}) => {
  const { t } = useTranslation("integrations");

  const genericSetupOptions = useMemo<SelectionGridOption<SetupMethod>[]>(
    () => [
      {
        key: "autodetect",
        label: t("keyVault.autodetect"),
        icon: ScanSearch,
      },
      { key: "enter_key", label: t("keyVault.enterKey"), icon: Keyboard },
      { key: "extract", label: t("keyVault.extractConfig"), icon: Locate },
    ],
    [t]
  );

  // Get agent-specific env config from Rust
  const { config: envConfig, loading: configLoading } = useProviderConfig(
    data.agent_type
  );

  // Check if OAuth is configured (e.g., Codex with ChatGPT login)
  const isOAuthConfigured = data.auth_method === "oauth" && data.validated;

  // Check if API key was auto-detected (non-OAuth)
  const isApiKeyDetected =
    !isOAuthConfigured && data.validated && !!data.raw_key_input;

  // Single flat setup method — no nested selection
  const [setupMethod, setSetupMethod] = useState<SetupMethod>("autodetect");

  // Raw text input for extraction (separate from the actual key input)
  const [rawExtractInput, setRawExtractInput] = useState("");

  // Base URL mode: official (use provider default) or custom (user enters URL)
  const [baseUrlMode, setBaseUrlMode] = useState<BaseUrlMode>("official");
  const [baseUrlWarningDismissed, setBaseUrlWarningDismissed] = useState(false);
  const supportsProtocolSelection =
    (envConfig?.supportedProtocols.length ?? 0) > 1;
  const selectedProtocol =
    data.protocol ?? envConfig?.defaultProtocol ?? "openai";
  const officialBaseUrl =
    selectedProtocol === "anthropic" && data.agent_type === "zenmux_api"
      ? "https://zenmux.ai/api/anthropic"
      : envConfig?.defaultBaseUrl;

  // Sync official URL to data when in official mode (for validation)
  useEffect(() => {
    if (
      setupMethod === "enter_key" &&
      envConfig?.supportsBaseUrl &&
      baseUrlMode === "official" &&
      officialBaseUrl &&
      data.extracted_base_url !== officialBaseUrl
    ) {
      onChange({ extracted_base_url: officialBaseUrl });
    }
  }, [
    setupMethod,
    envConfig,
    baseUrlMode,
    officialBaseUrl,
    data.extracted_base_url,
    onChange,
  ]);

  // Handle successful extraction - called by parent after extraction succeeds
  const handleExtractionSuccess = useCallback(
    (_baseUrl?: string) => {
      setSetupMethod("enter_key");
      if (
        envConfig?.supportsBaseUrl &&
        officialBaseUrl &&
        _baseUrl &&
        _baseUrl !== officialBaseUrl
      ) {
        setBaseUrlMode("custom");
      }
    },
    [envConfig, officialBaseUrl]
  );

  const handleSetupMethodChange = (method: SetupMethod) => {
    if (method === setupMethod) return;
    setSetupMethod(method);

    // Each tab starts with a clean slate — clear stale validation from the previous tab
    onChange({
      raw_key_input: "",
      validated: false,
      auth_method: undefined,
      quota_info: undefined,
      available_models: [],
      enabled_models: [],
      model_aliases: [],
    });

    if (method === "enter_key") {
      onInputModeChange?.("direct");
      if (
        envConfig?.supportsBaseUrl &&
        officialBaseUrl &&
        data.extracted_base_url &&
        data.extracted_base_url !== officialBaseUrl
      ) {
        setBaseUrlMode("custom");
      }
    } else if (method === "extract") {
      onInputModeChange?.("natural");
    }
  };

  if (configLoading || !envConfig) {
    return null;
  }

  return (
    <div className={SECTION_GAP_CLASSES}>
      <SectionContainer>
        <SectionRow
          label={t("keyVault.setupMethod")}
          description={t("keyVault.setupMethodDesc")}
          layout="vertical"
          required
        >
          <SelectionGrid
            options={genericSetupOptions}
            selected={setupMethod}
            cardVariant="subtle"
            onSelect={(key) => handleSetupMethodChange(key)}
          />
        </SectionRow>
      </SectionContainer>

      {/* ======================== */}
      {/* Autodetect Section       */}
      {/* ======================== */}
      {setupMethod === "autodetect" && (
        <>
          <SectionContainer>
            <SectionRow
              label={
                isOAuthConfigured
                  ? t("keyVault.connectedViaChatGpt")
                  : isApiKeyDetected
                    ? t("keyVault.apiKeyDetectedFromConfig")
                    : t("keyVault.findApiKeyFromConfig")
              }
              description={t("keyVault.scansEnvAndCliConfig")}
              required
            >
              <Button
                variant={
                  isOAuthConfigured || isApiKeyDetected ? "success" : "primary"
                }
                appearance={
                  isOAuthConfigured || isApiKeyDetected ? "outline" : undefined
                }
                size="default"
                loading={autoDetecting}
                disabled={autoDetecting}
                onClick={() => onAutoDetect?.()}
                className="h-8 min-h-8"
              >
                {isOAuthConfigured || isApiKeyDetected
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

      {/* ======================== */}
      {/* Enter Key Section        */}
      {/* ======================== */}
      {setupMethod === "enter_key" && (
        <SectionContainer>
          <SectionRow
            label={t("keyVault.apiKeyLabel")}
            description={t("keyVault.apiKeyDesc")}
            layout="vertical"
            required
          >
            <Input
              value={data.raw_key_input}
              onChange={(value) => onChange({ raw_key_input: value })}
              placeholder={t("keyVault.apiKeyPlaceholder")}
              size="default"
              className="w-full"
            />
          </SectionRow>

          {supportsProtocolSelection && (
            <SectionRow
              label="API protocol"
              description="Choose the wire protocol for the built-in Rust agent."
              layout="vertical"
            >
              <Select
                value={selectedProtocol}
                onChange={(val) => {
                  const protocol = val as typeof selectedProtocol;
                  const nextOfficialBaseUrl =
                    protocol === "anthropic" && data.agent_type === "zenmux_api"
                      ? "https://zenmux.ai/api/anthropic"
                      : envConfig.defaultBaseUrl;
                  onChange({
                    protocol,
                    extracted_base_url:
                      baseUrlMode === "official"
                        ? nextOfficialBaseUrl || undefined
                        : data.extracted_base_url,
                    validated: false,
                    available_models: [],
                    enabled_models: [],
                  });
                }}
                options={envConfig.supportedProtocols.map((protocol) => ({
                  value: protocol,
                  label: protocol === "anthropic" ? "Anthropic" : "OpenAI",
                }))}
                size="default"
                dropdownWidthMode="min-match"
                className="w-fit"
              />
            </SectionRow>
          )}

          {envConfig.supportsBaseUrl && (
            <SectionRow
              label={t("keyVault.baseUrlLabel")}
              description={t("keyVault.baseUrlDesc")}
              layout="vertical"
            >
              <div className="flex items-center gap-2">
                <Select
                  value={baseUrlMode}
                  onChange={(val) => {
                    const mode = val as BaseUrlMode;
                    setBaseUrlMode(mode);
                    if (mode === "official") {
                      setBaseUrlWarningDismissed(false);
                      onChange({
                        extracted_base_url: officialBaseUrl || undefined,
                      });
                    }
                  }}
                  options={[
                    {
                      value: "official",
                      label: t("keyVault.officialUrl"),
                    },
                    {
                      value: "custom",
                      label: t("keyVault.customUrl"),
                    },
                  ]}
                  size="default"
                  dropdownWidthMode="min-match"
                  className="w-fit shrink-0"
                />
                <Input
                  value={
                    baseUrlMode === "official"
                      ? officialBaseUrl || ""
                      : data.extracted_base_url || ""
                  }
                  onChange={(value) =>
                    onChange({ extracted_base_url: value || undefined })
                  }
                  size="default"
                  className="min-w-0 flex-1"
                  disabled={baseUrlMode === "official"}
                />
              </div>
            </SectionRow>
          )}

          {envConfig.supportsBaseUrl &&
            baseUrlMode === "custom" &&
            !baseUrlWarningDismissed && (
              <InlineAlert
                type="warning"
                title={t("keyVault.customBaseUrlRiskTitle")}
                className="mt-2"
                onClose={() => setBaseUrlWarningDismissed(true)}
              >
                {t("keyVault.customBaseUrlRiskWarning")}
              </InlineAlert>
            )}

          <SectionRow label="" showHeader={false}>
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
          </SectionRow>
        </SectionContainer>
      )}

      {/* ======================== */}
      {/* Extract Config Section   */}
      {/* ======================== */}
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
    </div>
  );
};

export { GenericSetup };
