/**
 * KiroSetup Component
 *
 * Setup UI for Kiro Pro agent — uses "Setup Method" selector consistent
 * with CursorSetup and GenericSetup.
 * - Autodetect: Find existing tokens from kiro-cli local storage
 * - Sign In: Device authorization flow via kiro-cli
 *
 * Uses SectionContainer + SectionRow + SECTION_GAP_CLASSES.
 */
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { KiroSessionSetup } from "@src/features/SessionSetup";
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

import type { KiroSetupProps } from "./types";

const KiroSetup: React.FC<KiroSetupProps> = ({
  data: _data,
  onChange: _onChange,
  tokenDetected,
  detectingToken,
  tokenError,
  onDetectToken,
  onClearTokenError,
  onSessionCaptured,
  preselectedMethod,
}) => {
  const { t } = useTranslation("integrations");

  const [localMethod, setLocalMethod] = useState<"autodetect" | "signin">(
    () => (preselectedMethod as "autodetect" | "signin") || "autodetect"
  );
  const hideSelector = !!preselectedMethod;
  const setupMethod = preselectedMethod
    ? (preselectedMethod as "autodetect" | "signin")
    : localMethod;

  const kiroSetupOptions: SelectionGridOption[] = useMemo(
    () => [
      {
        key: "autodetect",
        label: t("keyVault.autodetect"),
        icon: SearchAreaIcon,
      },
      { key: "signin", label: t("keyVault.signIn"), icon: Login01Icon },
    ],
    [t]
  );

  return (
    <div className={SECTION_GAP_CLASSES}>
      {!hideSelector && (
        <SectionContainer>
          <SectionRow
            label={t("keyVault.setupMethod")}
            description={t("keyVault.setupMethodDesc")}
            layout="vertical"
            required
          >
            <SelectionGrid
              options={kiroSetupOptions}
              selected={setupMethod}
              cardVariant="subtle"
              compactCards
              onSelect={(key) => setLocalMethod(key as "autodetect" | "signin")}
            />
          </SectionRow>
        </SectionContainer>
      )}

      {/* ======================== */}
      {/* Autodetect Section       */}
      {/* ======================== */}
      {setupMethod === "autodetect" && (
        <>
          <SectionContainer>
            <SectionRow
              label={
                tokenDetected
                  ? t("keyVault.tokenDetectedFromKiroCli")
                  : t("keyVault.findTokensFromKiroCli")
              }
              description={t("keyVault.readsFromKiroCliConfig")}
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
              {t("keyVault.kiroDetectErrorHint")}
            </InlineAlert>
          )}
        </>
      )}

      {/* ======================== */}
      {/* Sign In Section          */}
      {/* ======================== */}
      {setupMethod === "signin" && (
        <KiroSessionSetup
          onSessionCaptured={(values) => {
            onSessionCaptured?.(values);
          }}
        />
      )}
    </div>
  );
};

export { KiroSetup };
