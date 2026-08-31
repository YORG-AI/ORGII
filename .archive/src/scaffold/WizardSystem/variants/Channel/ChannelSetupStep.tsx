/**
 * ChannelSetupStep Component
 *
 * Wizard step 2: fill in channel-specific credentials before creating.
 * Uses SectionContainer + SectionRow for form layout.
 *
 * Includes a "Test Connection" probe button that validates credentials
 * against the channel's service API before allowing creation.
 */
import React, { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import { HugeiconsIcon, Tick01Icon } from "@src/icons";
import { probeChannel } from "@src/modules/MainApp/Integrations/Connections/Channels/api";
import type { ChannelProbeResult } from "@src/modules/MainApp/Integrations/Connections/Channels/types";
import {
  SECTION_GAP_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { WizardStepLayout } from "@src/scaffold/WizardSystem/primitives";

import { CHANNEL_FORMS, canSubmitChannel } from "./SetupForms";

export interface ChannelSetupStepProps {
  channelType: string;
  channelConfig: Record<string, unknown>;
  onConfigChange: (updates: Record<string, unknown>) => void;
  onSubmit: () => void;
  onBack: () => void;
  /** Cancel handler — renders a footer Cancel button in front of Back/Done. */
  onCancel?: () => void;
}

const ChannelSetupStep: React.FC<ChannelSetupStepProps> = ({
  channelType,
  channelConfig,
  onConfigChange,
  onSubmit,
  onBack,
  onCancel,
}) => {
  const { t } = useTranslation("integrations");

  const [probing, setProbing] = useState(false);
  const [probeResult, setProbeResult] = useState<ChannelProbeResult | null>(
    null
  );
  const [probeErrorDismissed, setProbeErrorDismissed] = useState(false);
  const probeIdRef = useRef(0);

  useEffect(() => {
    if (probeResult && !probeResult.ok) setProbeErrorDismissed(false);
  }, [probeResult]);

  const ChannelForm = CHANNEL_FORMS[channelType];
  const isValid = canSubmitChannel(channelType, channelConfig);

  const handleProbe = useCallback(async () => {
    const currentId = ++probeIdRef.current;
    setProbing(true);
    setProbeResult(null);
    try {
      const result = await probeChannel(channelType, channelConfig);
      if (probeIdRef.current !== currentId) return;
      setProbeResult(result);
    } catch (err) {
      if (probeIdRef.current !== currentId) return;
      setProbeResult({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        elapsed_ms: 0,
      });
    } finally {
      if (probeIdRef.current === currentId) setProbing(false);
    }
  }, [channelType, channelConfig]);

  return (
    <WizardStepLayout
      currentStep={2}
      totalSteps={2}
      onCancel={onCancel}
      footerLeft={
        probeResult?.ok ? (
          <div className="flex items-center gap-1.5">
            <HugeiconsIcon
              icon={Tick01Icon}
              data-icon="check"
              size={14}
              className="text-success-6"
            />
            <span className="text-[12px] text-success-6">
              {t("integrations.verified")}
            </span>
          </div>
        ) : undefined
      }
      actions={
        <>
          <Button variant="secondary" size="small" onClick={onBack}>
            {t("common:actions.back")}
          </Button>
          <Button
            variant="primary"
            size="small"
            disabled={!isValid}
            onClick={onSubmit}
          >
            {t("common:actions.done")}
          </Button>
        </>
      }
    >
      <div className={SECTION_GAP_CLASSES}>
        {ChannelForm ? (
          <ChannelForm config={channelConfig} onChange={onConfigChange} />
        ) : null}

        <SectionContainer>
          <SectionRow
            label={t("integrations.testConnection")}
            description={t("integrations.testConnectionDesc")}
            required
          >
            <Button
              variant={probeResult?.ok ? "success" : "primary"}
              appearance={probeResult?.ok ? "outline" : undefined}
              size="default"
              loading={probing}
              disabled={!isValid || probing}
              onClick={handleProbe}
              className="h-8 min-h-8"
            >
              {probeResult?.ok
                ? `✓ ${t("integrations.probeSuccess")}`
                : t("integrations.testConnection")}
            </Button>
          </SectionRow>
        </SectionContainer>
        {probeResult && !probeResult.ok && !probeErrorDismissed && (
          <div className="mt-3">
            <InlineAlert
              type="danger"
              onClose={() => setProbeErrorDismissed(true)}
            >
              {probeResult.error || t("integrations.probeFailed")}
            </InlineAlert>
          </div>
        )}
      </div>
    </WizardStepLayout>
  );
};

export default ChannelSetupStep;
