import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type {
  ProviderEndpoint,
  ProviderProtocol,
} from "@src/api/tauri/rpc/schemas/validation";
import Select from "@src/components/Select";
import {
  SECTION_CONTROL_STYLE,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import { getOfficialBaseUrl } from "../../config/providerEndpoints";
import type { AgentSetupProps } from "./types";

type BaseUrlMode = "official" | "custom";

interface ApiProtocolSectionRowProps {
  /** Endpoint in effect — supplies the URL for whichever protocol is chosen. */
  selectedEndpoint: ProviderEndpoint | undefined;
  selectedProtocol: ProviderProtocol;
  supportedProtocols: readonly ProviderProtocol[];
  defaultBaseUrl?: string | null;
  baseUrlMode: BaseUrlMode;
  extractedBaseUrl?: string;
  onChange: AgentSetupProps["onChange"];
}

export function ApiProtocolSectionRow({
  selectedEndpoint,
  selectedProtocol,
  supportedProtocols,
  defaultBaseUrl,
  baseUrlMode,
  extractedBaseUrl,
  onChange,
}: ApiProtocolSectionRowProps) {
  const { t } = useTranslation("integrations");

  const protocolOptions = useMemo(
    () =>
      supportedProtocols.map((protocol) => ({
        value: protocol,
        label: protocol === "anthropic" ? "Anthropic" : "OpenAI",
      })),
    [supportedProtocols]
  );

  const handleProtocolChange = (
    protocol: string | number | (string | number)[]
  ) => {
    // Single-select Select, so an array can't reach us — narrow rather than cast.
    if (Array.isArray(protocol)) return;
    const nextProtocol = protocol as ProviderProtocol;
    const nextOfficialBaseUrl = getOfficialBaseUrl(
      selectedEndpoint,
      nextProtocol,
      defaultBaseUrl
    );
    onChange({
      protocol: nextProtocol,
      extracted_base_url:
        baseUrlMode === "official"
          ? nextOfficialBaseUrl || undefined
          : extractedBaseUrl,
      validated: false,
      available_models: [],
      model_context_lengths: {},
      enabled_models: [],
    });
  };

  return (
    <SectionRow
      label={t("keyVault.apiProtocolLabel")}
      description={t("keyVault.apiProtocolDesc")}
    >
      <Select
        value={selectedProtocol}
        onChange={handleProtocolChange}
        options={protocolOptions}
        size="default"
        style={SECTION_CONTROL_STYLE}
      />
    </SectionRow>
  );
}
