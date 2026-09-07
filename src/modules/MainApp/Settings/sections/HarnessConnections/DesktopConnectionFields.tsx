import React from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import Select from "@src/components/Select";
import {
  SECTION_CONTROL_STYLE,
  SECTION_DESCRIPTION_CLASSES,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

export default function DesktopConnectionFields({
  endpoint,
  authScheme,
  model,
  disabled,
  onEndpoint,
  onAuth,
  onModel,
}: {
  endpoint: string;
  authScheme: "bearer" | "x-api-key";
  model: string;
  disabled: boolean;
  onEndpoint: (value: string) => void;
  onAuth: (value: "bearer" | "x-api-key") => void;
  onModel: (value: string) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <>
      <SectionRow label={t("harnessConnections.endpoint")}>
        <Input
          aria-label={t("harnessConnections.endpoint")}
          value={endpoint}
          disabled={disabled}
          onChange={onEndpoint}
          placeholder="https://gateway.example"
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow label={t("harnessConnections.authentication")}>
        <Select
          ariaLabel={t("harnessConnections.authentication")}
          value={authScheme}
          disabled={disabled}
          style={SECTION_CONTROL_STYLE}
          options={[
            { value: "bearer", label: "Bearer token" },
            { value: "x-api-key", label: "API key (x-api-key)" },
          ]}
          onChange={(value) =>
            onAuth(value === "x-api-key" ? "x-api-key" : "bearer")
          }
        />
      </SectionRow>
      <SectionRow label={t("harnessConnections.model")}>
        <Input
          aria-label={t("harnessConnections.model")}
          value={model}
          disabled={disabled}
          onChange={onModel}
          placeholder="claude-sonnet-5"
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow showHeader={false}>
        <p className={SECTION_DESCRIPTION_CLASSES}>
          {t("harnessConnections.desktopCredentials")}
        </p>
      </SectionRow>
    </>
  );
}
