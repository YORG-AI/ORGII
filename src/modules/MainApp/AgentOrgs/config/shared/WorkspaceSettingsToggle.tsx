import React, { useCallback } from "react";
import { useTranslation } from "react-i18next";

import Switch from "@src/components/Switch";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

interface WorkspaceSettingsToggleProps {
  config: Record<string, unknown>;
  update: (path: string, value: unknown) => void;
  configKey: "loadWorkspaceResources" | "loadWorkspaceRules";
  labelKey: string;
  descriptionKey: string;
  dataTestId: string;
}

const WorkspaceSettingsToggle: React.FC<WorkspaceSettingsToggleProps> = ({
  config,
  update,
  configKey,
  labelKey,
  descriptionKey,
  dataTestId,
}) => {
  const { t } = useTranslation("settings");
  const enabled = config[configKey] !== false;

  const handleChange = useCallback(
    (nextEnabled: boolean) => {
      update(configKey, nextEnabled);
    },
    [configKey, update]
  );

  return (
    <SectionContainer>
      <SectionRow label={t(labelKey)} description={t(descriptionKey)}>
        <Switch
          checked={enabled}
          onCheckedChange={handleChange}
          dataTestId={dataTestId}
        />
      </SectionRow>
    </SectionContainer>
  );
};

export default WorkspaceSettingsToggle;
