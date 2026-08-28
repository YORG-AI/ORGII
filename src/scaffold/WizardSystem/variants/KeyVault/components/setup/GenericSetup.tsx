/**
 * GenericSetup Component
 *
 * Setup UI for generic API key agents (Claude Code, Codex, etc.)
 * Uses a flat "Setup Method" selector. Available methods come from the Rust
 * agent registry (`supportedSetupMethods` on `AvailableAgent`).
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
import { useAtomValue } from "jotai";
import type { FC } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import Textarea from "@src/components/Textarea";
import { ClipboardCopyIcon, KeyboardIcon, SearchAreaIcon } from "@src/icons";
import {
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  type SelectionGridOption,
} from "@src/scaffold/WizardSystem/primitives";
import { agentRegistryAtom } from "@src/store/session/agentRegistryAtom";

import { useProviderConfig } from "../../config";
import {
  GENERIC_SETUP_METHOD,
  type GenericSetupMethod,
  resolveActiveSetupMethod,
  resolveGenericSetupMethods,
} from "../../config/genericSetupMethods";
import {
  getOfficialBaseUrl,
  hasEndpointChoice,
  resolveSelectedEndpoint,
} from "../../config/providerEndpoints";
import { ApiProtocolSectionRow } from "./ApiProtocolSectionRow";
import { CustomBaseUrlInfoIcon } from "./CustomBaseUrlInfoIcon";
import { ProviderEndpointSectionRow } from "./ProviderEndpointSectionRow";
import type { AgentSetupProps } from "./types";

type SetupMethod = GenericSetupMethod;
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
  const { agents } = useAtomValue(agentRegistryAtom);

  const allowedSetupMethods = useMemo(
    () =>
      resolveGenericSetupMethods(
        agents.find((agent) => agent.name === data.agent_type)
          ?.supportedSetupMethods
      ),
    [agents, data.agent_type]
  );

  const [setupMethod, setSetupMethod] = useState<SetupMethod>(
    GENERIC_SETUP_METHOD.AUTODETECT
  );
  const activeSetupMethod = resolveActiveSetupMethod(
    setupMethod,
    allowedSetupMethods
  );

  const genericSetupOptions = useMemo<
    SelectionGridOption<SetupMethod>[]
  >(() => {
    const optionByMethod: Record<
      SetupMethod,
      SelectionGridOption<SetupMethod>
    > = {
      [GENERIC_SETUP_METHOD.AUTODETECT]: {
        key: GENERIC_SETUP_METHOD.AUTODETECT,
        label: t("keyVault.autodetect"),
        icon: SearchAreaIcon,
      },
      [GENERIC_SETUP_METHOD.ENTER_KEY]: {
        key: GENERIC_SETUP_METHOD.ENTER_KEY,
        label: t("keyVault.enterKey"),
        icon: KeyboardIcon,
      },
      [GENERIC_SETUP_METHOD.EXTRACT]: {
        key: GENERIC_SETUP_METHOD.EXTRACT,
        label: t("keyVault.extractConfig"),
        icon: ClipboardCopyIcon,
      },
    };

    return allowedSetupMethods.map((method) => optionByMethod[method]);
  }, [allowedSetupMethods, t]);

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
  // Raw text input for extraction (separate from the actual key input)
  const [rawExtractInput, setRawExtractInput] = useState("");

  // Base URL mode: official (use provider default) or custom (user enters URL)
  const [baseUrlMode, setBaseUrlMode] = useState<BaseUrlMode>("official");
  const supportsProtocolSelection =
    (envConfig?.supportedProtocols.length ?? 0) > 1;
  const selectedProtocol =
    data.protocol ?? envConfig?.defaultProtocol ?? "openai";

  const endpoints = useMemo(
    () => envConfig?.endpoints ?? [],
    [envConfig?.endpoints]
  );
  const offersEndpointChoice = hasEndpointChoice(endpoints);
  const selectedEndpoint = resolveSelectedEndpoint(
    endpoints,
    data.extracted_base_url,
    data.selected_endpoint_id
  );
  const officialBaseUrl = getOfficialBaseUrl(
    selectedEndpoint,
    selectedProtocol,
    envConfig?.defaultBaseUrl
  );

  // Sync official URL to data when in official mode (for validation)
  useEffect(() => {
    // A provider with a choice of endpoints has no meaningful "unset" base URL:
    // validation has to know which host the key belongs to. Seed the default.
    if (offersEndpointChoice && !data.extracted_base_url && officialBaseUrl) {
      onChange({
        extracted_base_url: officialBaseUrl,
        validated: false,
        available_models: [],
        model_context_lengths: {},
        enabled_models: [],
      });
      return;
    }

    if (
      activeSetupMethod === GENERIC_SETUP_METHOD.ENTER_KEY &&
      envConfig?.supportsBaseUrl &&
      baseUrlMode === "official" &&
      officialBaseUrl &&
      data.extracted_base_url !== officialBaseUrl
    ) {
      onChange({ extracted_base_url: officialBaseUrl });
    }
  }, [
    activeSetupMethod,
    offersEndpointChoice,
    envConfig,
    baseUrlMode,
    officialBaseUrl,
    data.extracted_base_url,
    onChange,
  ]);

  // Handle successful extraction - called by parent after extraction succeeds
  const handleExtractionSuccess = useCallback(
    (_baseUrl?: string) => {
      setSetupMethod(GENERIC_SETUP_METHOD.ENTER_KEY);
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
    if (method === activeSetupMethod) return;
    setSetupMethod(method);

    // Each tab starts with a clean slate — clear stale validation from the previous tab
    onChange({
      raw_key_input: "",
      validated: false,
      auth_method: undefined,
      quota_info: undefined,
      available_models: [],
      model_context_lengths: {},
      enabled_models: [],
      model_aliases: [],
    });

    if (method === GENERIC_SETUP_METHOD.ENTER_KEY) {
      onInputModeChange?.("direct");
      if (
        envConfig?.supportsBaseUrl &&
        officialBaseUrl &&
        data.extracted_base_url &&
        data.extracted_base_url !== officialBaseUrl
      ) {
        setBaseUrlMode("custom");
      }
    } else if (method === GENERIC_SETUP_METHOD.EXTRACT) {
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
            selected={activeSetupMethod}
            cardVariant="subtle"
            compactCards
            onSelect={(key) => handleSetupMethodChange(key)}
          />
        </SectionRow>
      </SectionContainer>

      {offersEndpointChoice && (
        <SectionContainer>
          <ProviderEndpointSectionRow
            endpoints={endpoints}
            selectedEndpointId={selectedEndpoint?.id}
            protocol={selectedProtocol}
            onChange={onChange}
          />
        </SectionContainer>
      )}

      {/* ======================== */}
      {/* Autodetect Section       */}
      {/* ======================== */}
      {activeSetupMethod === GENERIC_SETUP_METHOD.AUTODETECT && (
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
      {activeSetupMethod === GENERIC_SETUP_METHOD.ENTER_KEY && (
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
            <ApiProtocolSectionRow
              selectedEndpoint={selectedEndpoint}
              selectedProtocol={selectedProtocol}
              supportedProtocols={envConfig.supportedProtocols}
              defaultBaseUrl={envConfig.defaultBaseUrl}
              baseUrlMode={baseUrlMode}
              extractedBaseUrl={data.extracted_base_url}
              onChange={onChange}
            />
          )}

          {envConfig.supportsBaseUrl && (
            <SectionRow
              label={
                <span className="inline-flex items-center gap-1">
                  {t("keyVault.baseUrlLabel")}
                  {baseUrlMode === "custom" ? <CustomBaseUrlInfoIcon /> : null}
                </span>
              }
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
      {activeSetupMethod === GENERIC_SETUP_METHOD.EXTRACT && (
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
