/**
 * ApiSetup — single-step wizard body.
 *
 * Combines provider selection, credential entry, and (once the key
 * Validates) the auto-detected model list plus optional user-added models in
 * the shared ModelTable. Delegates to agent-specific setup components for the credential
 * section. State and logic live in `useApiSetup`.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { testModelAvailability } from "@src/api/services/keyValidation";
import type { QuotaSnapshot } from "@src/api/types/keyVault";
import { LOCAL_MODEL_PROVIDER } from "@src/api/types/keys";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import Select from "@src/components/Select";
import {
  SECTION_CONTROL_STYLE,
  SECTION_GAP_CLASSES,
  SECTION_SUBHEADING_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";
import { SelectionGrid } from "@src/scaffold/WizardSystem/primitives";
import { parseModelVariants } from "@src/util/modelVariants";

import { useApiSetup } from "../hooks/useApiSetup";
import { useProviderSelection } from "../hooks/useProviderSelection";
import type { ApiSetupProps } from "../types";
import { AgentSetupRouter } from "./AgentSetupRouter";
import ApiSetupFooter from "./ApiSetupFooter";
import CopilotPinnedSection from "./CopilotPinnedSection";
import CursorPinnedSection from "./CursorPinnedSection";
import ModelsDisplay from "./ModelsDisplay";
import ValidationResults from "./ValidationResults";
import { filterOptionBySearchText } from "./providerOptions";

const ApiSetup: React.FC<ApiSetupProps> = ({
  data,
  onChange,
  onNext,
  onCancel,
  submitLabel,
  loading,
  primaryProvidersOnly = false,
  existingAccountNames,
  browserCloseSignal = 0,
  onBrowserStateChange,
}) => {
  const { t } = useTranslation("integrations");
  const hook = useApiSetup({ data, onChange });
  const [errors, setErrors] = useState<{ agent_type?: string }>({});

  const {
    selectedProviderKey,
    selectedProvider,
    hasMultipleVariants,
    providerGridOptions,
    providerSelectOptions,
    variantGridOptions,
    variantSelectOptions,
    complexMethodOptions,
    isComplex,
    handleProviderSelect: _handleProviderSelectBase,
    handleProviderClear,
    handleVariantSelect,
    handleVariantClear,
  } = useProviderSelection({ data, onChange, primaryProvidersOnly });

  const handleProviderSelect = (providerKey: string) => {
    setErrors((prev) => ({ ...prev, agent_type: undefined }));
    _handleProviderSelectBase(providerKey);
  };

  useEffect(() => {
    onBrowserStateChange?.(hook.browserOpen);
  }, [hook.browserOpen, onBrowserStateChange]);

  const parsedModelVariants = useMemo(
    () =>
      parseModelVariants(data.available_models ?? []).map((variant) => ({
        model: variant.model,
        base_model: variant.baseModel,
        reasoning: variant.reasoning,
        fast: variant.fast,
      })),
    [data.available_models]
  );

  const hasAgent = !!data.agent_type;

  // ============================================
  // Navigation
  // ============================================

  const [nameError, setNameError] = useState<string | null>(null);
  const [nameTouched, setNameTouched] = useState(false);

  const existingNameSet = useMemo(
    () =>
      new Set(
        (existingAccountNames ?? []).map((name) => name.trim().toLowerCase())
      ),
    [existingAccountNames]
  );

  // Live duplicate detection — re-evaluated on every keystroke.
  const trimmedName = data.name.trim();
  const isDuplicateName =
    trimmedName !== "" && existingNameSet.has(trimmedName.toLowerCase());

  const handleNext = () => {
    if (isDuplicateName) {
      setNameTouched(true);
      setNameError(t("keyVault.nameDuplicate"));
      return;
    }

    if (!data.agent_type) {
      setErrors({
        agent_type: t("keyVault.providerRequired", {
          label: t("wizard.pickProvider", "Provider"),
        }),
      });
      return;
    }

    if (!hook.canProceed) return;

    onNext();
  };

  // ============================================
  // Pinned section flags
  // ============================================

  const isClaudeCode = hook.agentCategory === "claude_code";
  const isCodex = hook.agentCategory === "codex";
  const copilotUsesBrowser = hook.isCopilot && data.setup_method === "create";
  const cursorUsesBrowser = hook.isCursor && hook.useGuidedSetup;
  const showCopilotPinned = copilotUsesBrowser;
  const showCursorPinned = cursorUsesBrowser;
  const hasPinnedSection = showCopilotPinned || showCursorPinned;
  const hideFooter = (isClaudeCode || isCodex) && hook.browserOpen;

  const effectiveKeyValidated = hook.keyValidated || data.validated;

  const showValidationResults =
    !(hook.isCursor && hook.useGuidedSetup) &&
    !hook.isCopilot &&
    !hook.isOAuthAgent;

  const isLocalModelProvider = data.agent_type === LOCAL_MODEL_PROVIDER;

  const showModelSections =
    !hook.browserOpen &&
    !!data.agent_type &&
    (effectiveKeyValidated ||
      (hook.isCursor && data.validated) ||
      (hook.isOAuthAgent && data.validated) ||
      isLocalModelProvider);

  const accountNameBase =
    selectedProvider?.label ||
    data.agent_type ||
    t("wizard.pickProvider", "Provider");

  const accountNameSection = (
    <SectionContainer>
      <SectionRow
        label={t("keyVault.accountName")}
        description={t("keyVault.accountNameDesc", {
          provider: accountNameBase,
        })}
      >
        <Input
          value={data.name}
          onChange={(value) => {
            onChange({ name: value });
            if (nameError) setNameError(null);
            if (nameTouched) setNameTouched(false);
          }}
          onBlur={() => {
            if (trimmedName) setNameTouched(true);
          }}
          placeholder={t("keyVault.accountNamePlaceholder", {
            provider: accountNameBase,
          })}
          size="default"
          style={SECTION_CONTROL_STYLE}
          errorMessage={
            nameTouched && isDuplicateName
              ? t("keyVault.nameDuplicate")
              : (nameError ?? undefined)
          }
          errorPlacement="left"
        />
      </SectionRow>
    </SectionContainer>
  );

  const handleTestModel = useCallback(
    async (model: string) => {
      const apiKey = data.extracted_api_key || data.raw_key_input;
      const baseUrl = data.extracted_base_url;
      if (!apiKey || !baseUrl) {
        return { available: true, message: "No base URL — skipping test" };
      }
      return testModelAvailability(apiKey, baseUrl, model, data.agent_type);
    },
    [
      data.extracted_api_key,
      data.raw_key_input,
      data.extracted_base_url,
      data.agent_type,
    ]
  );

  // ============================================
  // Render
  // ============================================

  return (
    <div className="flex h-full flex-col">
      {/* Content */}
      <div
        className={`min-h-0 flex-1 ${
          hook.browserOpen
            ? "flex flex-col overflow-hidden"
            : `${DETAIL_PANEL_TOKENS.contentPadding} ${DETAIL_PANEL_TOKENS.contentPaddingBottom} scrollbar-overlay overflow-y-auto`
        }`}
      >
        <div
          className={
            hook.browserOpen
              ? "flex min-h-0 flex-1 flex-col"
              : `${DETAIL_PANEL_TOKENS.contentWidth} ${SECTION_GAP_CLASSES} ${DETAIL_PANEL_TOKENS.contentScrollBottom}`
          }
        >
          {/* Provider, method, and region sections — hidden when browser is open */}
          {!hook.browserOpen && (
            <>
              {accountNameSection}

              <SectionContainer>
                {/* Provider selection */}
                {selectedProviderKey ? (
                  <SectionRow
                    label={t("wizard.pickProvider", "Provider")}
                    description={t("keyVault.selectorDesc")}
                    required
                  >
                    <Select
                      value={selectedProviderKey}
                      options={providerSelectOptions}
                      allowClear
                      showSearch
                      filterOption={filterOptionBySearchText}
                      onChange={(val) => handleProviderSelect(val as string)}
                      onClear={handleProviderClear}
                      style={SECTION_CONTROL_STYLE}
                    />
                  </SectionRow>
                ) : (
                  <SectionRow
                    label={t("wizard.pickProvider", "Provider")}
                    description={t("keyVault.selectorDesc")}
                    layout="vertical"
                    required
                  >
                    {errors.agent_type && (
                      <InlineAlert type="danger">
                        {errors.agent_type}
                      </InlineAlert>
                    )}
                    <SelectionGrid
                      options={providerGridOptions}
                      selected={null}
                      cardVariant="subtle"
                      onSelect={handleProviderSelect}
                    />
                  </SectionRow>
                )}

                {selectedProviderKey && hasMultipleVariants && (
                  <SectionRow
                    label={t("wizard.selectVariant", "Connection method")}
                    layout={data.agent_type ? "horizontal" : "vertical"}
                    required
                  >
                    {data.agent_type ? (
                      <Select
                        value={data.agent_type}
                        options={variantSelectOptions}
                        allowClear
                        showSearch
                        filterOption={filterOptionBySearchText}
                        onChange={(val) => handleVariantSelect(val as string)}
                        onClear={handleVariantClear}
                        style={SECTION_CONTROL_STYLE}
                      />
                    ) : (
                      <SelectionGrid
                        options={variantGridOptions}
                        selected={null}
                        cardVariant="subtle"
                        onSelect={handleVariantSelect}
                      />
                    )}
                  </SectionRow>
                )}

                {/* Setup Method — same container for Copilot and Kiro */}
                {!!data.agent_type &&
                  isComplex &&
                  complexMethodOptions.length > 0 &&
                  (isCodex || hook.isCopilot || hook.isKiro) && (
                    <SectionRow
                      label={t("keyVault.setupMethod")}
                      layout="vertical"
                      required
                    >
                      <SelectionGrid
                        options={complexMethodOptions}
                        selected={data.setup_method ?? null}
                        cardVariant="subtle"
                        onSelect={(key) => onChange({ setup_method: key })}
                      />
                    </SectionRow>
                  )}
              </SectionContainer>

              {/* Setup Method — separate container for Cursor */}
              {!!data.agent_type &&
                isComplex &&
                complexMethodOptions.length > 0 &&
                hook.isCursor && (
                  <SectionContainer>
                    <SectionRow
                      label={t("keyVault.setupMethod")}
                      layout="vertical"
                      required
                    >
                      <SelectionGrid
                        options={complexMethodOptions}
                        selected={data.setup_method ?? null}
                        cardVariant="subtle"
                        onSelect={(key) => onChange({ setup_method: key })}
                      />
                    </SectionRow>
                  </SectionContainer>
                )}
            </>
          )}

          {/* Agent-Specific key setup — shown once a provider is chosen */}
          {!!data.agent_type && (
            <AgentSetupRouter
              data={data}
              onChange={onChange}
              agentCategory={hook.agentCategory}
              isComplex={isComplex}
              setupMethod={data.setup_method}
              keyValidated={effectiveKeyValidated}
              validatingKey={hook.validatingKey}
              validationError={hook.validationError}
              fetchedModels={hook.fetchedModels}
              validateKey={hook.validateKey}
              browserOpen={hook.browserOpen}
              setBrowserOpen={hook.setBrowserOpen}
              browserCloseSignal={browserCloseSignal}
              inputMode={hook.inputMode}
              onInputModeChange={hook.setInputMode}
              onAutoDetect={hook.handleAutoDetectToken}
              autoDetecting={hook.detectingToken}
              autoDetectError={hook.tokenError}
              onClearAutoDetectError={hook.clearTokenError}
              onExtract={hook.handleExtract}
              extracting={hook.extracting}
              extractError={hook.extractError}
              onClearExtractError={hook.clearExtractError}
              tokenDetected={hook.tokenDetected}
              setTokenDetected={hook.setTokenDetected}
              detectingToken={hook.detectingToken}
              tokenError={hook.tokenError}
              clearTokenError={hook.clearTokenError}
              useGuidedSetup={hook.useGuidedSetup}
              setUseGuidedSetup={hook.setUseGuidedSetup}
              sessionTokenMode={hook.sessionTokenMode}
              setSessionTokenMode={hook.setSessionTokenMode}
              manualSessionToken={hook.manualSessionToken}
              handleManualTokenChange={hook.handleManualTokenChange}
              handleSessionTokenCaptured={hook.handleSessionTokenCaptured}
              handleUrlChange={hook.handleUrlChange}
              hasSessionToken={hook.hasSessionToken}
            />
          )}

          {!!data.agent_type && showValidationResults && (
            <ValidationResults
              keyValidated={effectiveKeyValidated}
              validationError={hook.validationError}
              agentCategory={hook.agentCategory}
              isApiProvider={hook.isApiProvider}
              extractedQuotaInfo={
                hook.extractedConfig?.quotaInfo as QuotaSnapshot | undefined
              }
            />
          )}

          {showModelSections && (
            <div className={`${SECTION_GAP_CLASSES} min-h-0`}>
              <div className="flex items-center justify-between">
                <div className={SECTION_SUBHEADING_CLASSES}>
                  {t("modelsTabs.models")}
                </div>
                <div className="text-[12px] text-text-3">
                  {t("keyVault.modelCount", {
                    count: data.available_models?.length ?? 0,
                  })}
                </div>
              </div>
              <ModelsDisplay
                models={data.available_models ?? []}
                enabledModels={data.enabled_models ?? []}
                onEnabledModelsChange={(models) =>
                  onChange({ enabled_models: models })
                }
                customModels={data.custom_models ?? []}
                onCustomModelsChange={(models) =>
                  onChange({ custom_models: models })
                }
                modelAliases={data.model_aliases}
                modelVariants={parsedModelVariants}
                onModelAliasesChange={(aliases) =>
                  onChange({ model_aliases: aliases })
                }
                onTestModel={handleTestModel}
                defaultVariants={data.default_variants}
                onChangeDefaultVariant={(baseModel, model) => {
                  const next = (data.default_variants ?? []).filter(
                    (entry) => entry.base_model !== baseModel
                  );
                  next.push({ base_model: baseModel, model });
                  onChange({ default_variants: next });
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Pinned Sections */}
      {showCopilotPinned && (
        <CopilotPinnedSection
          data={data}
          onChange={onChange}
          keyValidated={effectiveKeyValidated}
          validatingKey={hook.validatingKey}
          validationError={hook.validationError}
          validateKey={hook.validateKey}
          browserOpen={hook.browserOpen}
          detectedModelCount={data.available_models.length}
        />
      )}

      {showCursorPinned && (
        <CursorPinnedSection data={data} onChange={onChange} />
      )}

      {!hideFooter && (
        <ApiSetupFooter
          canProceed={hasAgent && hook.canProceed && !isDuplicateName}
          onNext={handleNext}
          onCancel={onCancel}
          hasPinnedSection={hasPinnedSection}
          submitLabel={submitLabel}
          loading={loading}
          showSessionTokenIndicator={
            hook.isCursor &&
            hook.useGuidedSetup &&
            !!hook.cursorSessionToken &&
            !hook.isOnLoginPage
          }
          showKeySelection={hook.showKeySelection}
          detectedKeys={hook.detectedKeys}
          selectedCredentialIndex={hook.selectedCredentialIndex}
          onSelectCredentialIndex={hook.setSelectedCredentialIndex}
          onConfirmKeySelection={hook.handleConfirmKeySelection}
          onCloseKeySelection={() => hook.setShowKeySelection(false)}
        />
      )}
    </div>
  );
};

export default ApiSetup;
