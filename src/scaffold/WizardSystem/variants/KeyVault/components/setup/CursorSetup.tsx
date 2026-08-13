/**
 * CursorSetup Component
 *
 * Setup UI for Cursor CLI agent with flat 3-option setup method:
 *   Guided Setup | Autodetect | Enter Token
 *
 * Uses SectionContainer + SectionRow + SECTION_GAP_CLASSES.
 */
import { Globe, Keyboard, ScanSearch } from "lucide-react";
import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Input from "@src/components/Input";
import { CursorSessionSetup } from "@src/features/SessionSetup";
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

import { CompactMethodRow } from "./CompactMethodSuffix";
import type { CursorSetupProps } from "./types";

type CursorMethod = "guided" | "autodetect" | "enter_token";

const CursorSetup: React.FC<CursorSetupProps> = ({
  data,
  onChange,
  browserOpen,
  setBrowserOpen,
  tokenDetected,
  detectingToken,
  tokenError,
  onDetectToken,
  onClearTokenError,
  useGuidedSetup,
  setUseGuidedSetup,
  sessionTokenMode,
  setSessionTokenMode,
  manualSessionToken,
  onManualTokenChange,
  onSessionTokenCaptured,
  onUrlChange,
  hasSessionToken: _hasSessionToken,
  preselectedMethod,
  browserCloseSignal,
}) => {
  const { t } = useTranslation("integrations");
  const [apiKeyAlertDismissed, setApiKeyAlertDismissed] = useState(false);
  const showApiKeyInfo =
    !data.raw_key_input.trim() &&
    !apiKeyAlertDismissed &&
    !(useGuidedSetup && browserOpen);

  const cursorSetupOptions: SelectionGridOption<CursorMethod>[] = useMemo(
    () => [
      { key: "guided", label: t("keyVault.guidedSetup"), icon: Globe },
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

  // Derive selected method from existing state
  const selectedMethod: CursorMethod = useGuidedSetup
    ? "guided"
    : sessionTokenMode === "auto"
      ? "autodetect"
      : "enter_token";

  const handleMethodChange = useCallback(
    (key: string) => {
      switch (key) {
        case "guided":
          setUseGuidedSetup(true);
          break;
        case "autodetect":
          setUseGuidedSetup(false);
          setBrowserOpen(false); // Reset browser state so parent content can scroll
          setSessionTokenMode("auto");
          onManualTokenChange("");
          break;
        case "enter_token":
          setUseGuidedSetup(false);
          setBrowserOpen(false); // Reset browser state so parent content can scroll
          setSessionTokenMode("manual");
          break;
      }
    },
    [
      setUseGuidedSetup,
      setBrowserOpen,
      setSessionTokenMode,
      onManualTokenChange,
    ]
  );

  const isCompact = browserOpen && useGuidedSetup;
  const isGuided = selectedMethod === "guided";
  const hideSelector = !!preselectedMethod;
  const apiKeyInfoAlert = showApiKeyInfo ? (
    <InlineAlert
      type="info"
      title={t("keyVault.cursorApiKeyRecommendedTitle")}
      onClose={() => setApiKeyAlertDismissed(true)}
    >
      <div>{t("keyVault.cursorApiKeyRecommendedDesc")}</div>
      <div>{t("keyVault.cursorApiKeyRecommendedAction")}</div>
    </InlineAlert>
  ) : null;
  const apiKeyInputSection = (
    <SectionContainer>
      <SectionRow
        label={t("keyVault.apiKeyLabel")}
        description={
          isGuided
            ? t("keyVault.cursorApiKeyBrowserHint")
            : t("keyVault.cursorApiKeyHint")
        }
      >
        <Input
          value={data.raw_key_input}
          onChange={(value) =>
            onChange({ raw_key_input: value, extracted_api_key: undefined })
          }
          placeholder={t("keyVault.cursorKeyFormatPlaceholder")}
          size="default"
          type="password"
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
    </SectionContainer>
  );

  const rootClassName =
    isGuided && browserOpen
      ? "flex h-full min-h-0 flex-1 flex-col"
      : SECTION_GAP_CLASSES;

  return (
    <div className={rootClassName}>
      {!hideSelector &&
        (isCompact ? (
          <CompactMethodRow
            title={t("keyVault.setupMethod")}
            options={cursorSetupOptions}
            selected={selectedMethod}
            onSelect={(key) => handleMethodChange(key)}
            label={t("keyVault.guidedSetup")}
            className="mb-2"
          />
        ) : (
          <SectionContainer>
            <SectionRow
              label={t("keyVault.setupMethod")}
              description={t("keyVault.setupMethodDesc")}
              layout="vertical"
              required
            >
              <SelectionGrid
                options={cursorSetupOptions}
                selected={selectedMethod}
                cardVariant="subtle"
                compactCards
                onSelect={(key) => handleMethodChange(key)}
              />
            </SectionRow>
          </SectionContainer>
        ))}

      {/* ======================== */}
      {/* Guided Setup Section     */}
      {/* ======================== */}
      {selectedMethod === "guided" && (
        <>
          <CursorSessionSetup
            onSessionTokenCaptured={onSessionTokenCaptured}
            onUrlChange={onUrlChange}
            onBrowserStateChange={setBrowserOpen}
            closeSignal={browserCloseSignal}
          />
          {apiKeyInfoAlert}
        </>
      )}

      {/* ======================== */}
      {/* Autodetect Section       */}
      {/* ======================== */}
      {selectedMethod === "autodetect" && (
        <>
          <SectionContainer>
            <SectionRow
              label={t("keyVault.sessionTokenLabel")}
              description={t("keyVault.sessionTokenAutoHint")}
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
              >
                {tokenDetected
                  ? `✓ ${t("keyVault.detected")}`
                  : t("keyVault.detect")}
              </Button>
            </SectionRow>
          </SectionContainer>
          {tokenError && (
            <InlineAlert
              type="danger"
              title={tokenError}
              onClose={onClearTokenError}
            >
              {t("keyVault.cursorDetectErrorHint")}
            </InlineAlert>
          )}
          {apiKeyInputSection}
          {apiKeyInfoAlert}
        </>
      )}

      {/* ======================== */}
      {/* Enter Token Section      */}
      {/* ======================== */}
      {selectedMethod === "enter_token" && (
        <>
          <SectionContainer>
            <SectionRow
              label={t("keyVault.sessionTokenLabel")}
              description={t("keyVault.sessionTokenManualHint")}
              required
            >
              <Input
                value={manualSessionToken}
                onChange={onManualTokenChange}
                placeholder={t("keyVault.cursorSessionTokenPlaceholder")}
                size="default"
                style={SECTION_CONTROL_STYLE}
              />
            </SectionRow>
          </SectionContainer>
          {apiKeyInputSection}
          {apiKeyInfoAlert}
        </>
      )}
    </div>
  );
};

export { CursorSetup };
