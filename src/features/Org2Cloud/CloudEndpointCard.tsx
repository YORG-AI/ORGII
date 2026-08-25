/**
 * "Advanced — custom backend" Settings card (cloud-parity Phase C).
 *
 * A single switch chooses the official managed endpoint or a self-deployed
 * backend. Custom endpoint fields are shown only while DIY mode is enabled.
 * Both URLs are https-only (zod, `Org2CloudEndpointOverrideSchema`). Applying
 * a custom endpoint or switching back to official invalidates every
 * backend-coupled piece of state, so both paths run
 * `resetCloudStateForEndpointSwitch()` (sign-out included).
 * Deliberately no setup help beyond the validation errors: deployment docs
 * live in the open-source infra repo.
 */
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { useAtom, useStore } from "jotai";
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Input from "@src/components/Input";
import Message from "@src/components/Message";
import Switch from "@src/components/Switch";

import {
  ORG2_CLOUD_OFFICIAL_ANON_KEY,
  ORG2_CLOUD_OFFICIAL_SUPABASE_URL,
  ORG2_CLOUD_OFFICIAL_WEB_ORIGIN,
  Org2CloudEndpointOverrideSchema,
} from "./config";
import {
  org2CloudEndpointOverrideAtom,
  resetCloudStateForEndpointSwitch,
} from "./org2CloudEndpointAtom";

interface FieldErrors {
  webOrigin?: string;
  supabaseUrl?: string;
  anonKey?: string;
}

const CloudEndpointCard: React.FC = () => {
  const { t } = useTranslation("navigation");
  const store = useStore();
  const [override, setOverride] = useAtom(org2CloudEndpointOverrideAtom);
  const [customEnabled, setCustomEnabled] = useState(override !== null);
  const [webOrigin, setWebOrigin] = useState(override?.webOrigin ?? "");
  const [supabaseUrl, setSupabaseUrl] = useState(override?.supabaseUrl ?? "");
  const [anonKey, setAnonKey] = useState(override?.anonKey ?? "");
  const [errors, setErrors] = useState<FieldErrors>({});

  const handleApply = useCallback(() => {
    const candidate = {
      webOrigin: webOrigin.trim(),
      supabaseUrl: supabaseUrl.trim(),
      anonKey: anonKey.trim(),
    };
    const { shape } = Org2CloudEndpointOverrideSchema;
    const nextErrors: FieldErrors = {};
    if (!shape.webOrigin.safeParse(candidate.webOrigin).success) {
      nextErrors.webOrigin = t("cloud.customEndpoint.httpsRequired");
    }
    if (!shape.supabaseUrl.safeParse(candidate.supabaseUrl).success) {
      nextErrors.supabaseUrl = t("cloud.customEndpoint.httpsRequired");
    }
    if (!shape.anonKey.safeParse(candidate.anonKey).success) {
      nextErrors.anonKey = t("cloud.customEndpoint.anonKeyRequired");
    }
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) return;
    // Typing the official endpoint back in by hand IS a reset-to-official:
    // store `null` so future official rotations don't strand a stale copy.
    const isOfficialTarget =
      candidate.webOrigin === ORG2_CLOUD_OFFICIAL_WEB_ORIGIN &&
      candidate.supabaseUrl === ORG2_CLOUD_OFFICIAL_SUPABASE_URL &&
      candidate.anonKey === ORG2_CLOUD_OFFICIAL_ANON_KEY;
    const useOfficialEndpoint = isOfficialTarget;
    setOverride(useOfficialEndpoint ? null : candidate);
    setCustomEnabled(!useOfficialEndpoint);
    resetCloudStateForEndpointSwitch(store);
    Message.success(t("cloud.customEndpoint.appliedToast"));
  }, [anonKey, setOverride, store, supabaseUrl, t, webOrigin]);

  const handleCustomEnabledChange = useCallback(
    (enabled: boolean) => {
      setCustomEnabled(enabled);
      setErrors({});
      if (enabled || override === null) return;

      setOverride(null);
      setWebOrigin("");
      setSupabaseUrl("");
      setAnonKey("");
      resetCloudStateForEndpointSwitch(store);
      Message.success(t("cloud.customEndpoint.resetToast"));
    },
    [override, setOverride, store, t]
  );

  return (
    <SectionContainer>
      <SectionRow
        label={t("cloud.customEndpoint.title")}
        description={t("cloud.customEndpoint.toggleDesc")}
      >
        <Switch
          checked={customEnabled}
          onCheckedChange={handleCustomEnabledChange}
          ariaLabel={t("cloud.customEndpoint.title")}
          dataTestId="org2-cloud-endpoint-toggle"
        />
      </SectionRow>
      {customEnabled && (
        <>
          <SectionRow label={t("cloud.customEndpoint.webOriginLabel")} indent>
            <Input
              size="default"
              value={webOrigin}
              onChange={setWebOrigin}
              placeholder="https://cloud.example.com"
              errorMessage={errors.webOrigin}
              style={SECTION_CONTROL_STYLE}
              data-testid="org2-cloud-endpoint-web-origin"
            />
          </SectionRow>
          <SectionRow label={t("cloud.customEndpoint.supabaseUrlLabel")} indent>
            <Input
              size="default"
              value={supabaseUrl}
              onChange={setSupabaseUrl}
              placeholder="https://your-project.supabase.co"
              errorMessage={errors.supabaseUrl}
              style={SECTION_CONTROL_STYLE}
              data-testid="org2-cloud-endpoint-supabase-url"
            />
          </SectionRow>
          <SectionRow label={t("cloud.customEndpoint.anonKeyLabel")} indent>
            <Input
              size="default"
              value={anonKey}
              onChange={setAnonKey}
              placeholder="sb_publishable_..."
              errorMessage={errors.anonKey}
              style={SECTION_CONTROL_STYLE}
              data-testid="org2-cloud-endpoint-anon-key"
            />
          </SectionRow>
          <SectionRow label={t("cloud.customEndpoint.apply")} indent>
            <Button
              size="default"
              onClick={handleApply}
              data-testid="org2-cloud-endpoint-apply"
            >
              {t("cloud.customEndpoint.apply")}
            </Button>
          </SectionRow>
        </>
      )}
    </SectionContainer>
  );
};

export default CloudEndpointCard;
