import { useAtom } from "jotai";
import React from "react";
import { useTranslation } from "react-i18next";

import Switch from "@src/components/Switch";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { cliUpdateAlertsEnabledAtom } from "@src/store/session";

const CliUpdateAlertsSettingsRow: React.FC = () => {
  const { t } = useTranslation("integrations");
  const [enabled, setEnabled] = useAtom(cliUpdateAlertsEnabledAtom);
  const label = t("agentOrgs.cliUpdateAlerts.label");

  return (
    <SectionContainer dataTestId="cli-update-alerts-settings">
      <SectionRow
        label={label}
        description={t("agentOrgs.cliUpdateAlerts.description")}
      >
        <Switch
          checked={enabled}
          onCheckedChange={setEnabled}
          ariaLabel={label}
          dataTestId="cli-update-alerts-switch"
        />
      </SectionRow>
    </SectionContainer>
  );
};

export default CliUpdateAlertsSettingsRow;
