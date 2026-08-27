/**
 * Signal Channel Configuration
 *
 * Uses signal-cli or signal-cli-rest-api bridge for end-to-end encrypted messaging.
 */
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import React from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import Switch from "@src/components/Switch";

import {
  getNestedBool,
  getNestedString,
  getNestedStringArray,
} from "../../../../AgentOrgs/config/osAgent/utils";
import type { ChannelConfigProps } from "../types";
import { parseCommaSeparated } from "../utils";

const SignalConfig: React.FC<ChannelConfigProps> = ({
  config,
  update,
  pathPrefix,
}) => {
  const { t } = useTranslation("integrations");

  const phoneNumber = getNestedString(config, `${pathPrefix}.phoneNumber`, "");
  const apiUrl = getNestedString(
    config,
    `${pathPrefix}.apiUrl`,
    "http://localhost:8080"
  );
  const autoStart = getNestedBool(config, `${pathPrefix}.autoStart`, false);
  const sendReadReceipts = getNestedBool(
    config,
    `${pathPrefix}.sendReadReceipts`,
    false
  );
  const allowFrom = getNestedStringArray(config, `${pathPrefix}.allowFrom`);

  return (
    <SectionContainer>
      <SectionRow
        label={t("channels.signalPhoneNumber")}
        description={t("channels.signalPhoneNumberDesc")}
      >
        <Input
          value={phoneNumber}
          onChange={(val: string) => update(`${pathPrefix}.phoneNumber`, val)}
          style={SECTION_CONTROL_STYLE}
          placeholder="+1234567890"
        />
      </SectionRow>
      <SectionRow
        label={t("channels.signalApiUrl")}
        description={t("channels.signalApiUrlDesc")}
      >
        <Input
          value={apiUrl}
          onChange={(val: string) => update(`${pathPrefix}.apiUrl`, val)}
          style={SECTION_CONTROL_STYLE}
          placeholder="http://localhost:8080"
        />
      </SectionRow>
      <SectionRow
        label={t("channels.signalAutoStart")}
        description={t("channels.signalAutoStartDesc")}
      >
        <Switch
          checked={autoStart}
          onCheckedChange={(checked: boolean) =>
            update(`${pathPrefix}.autoStart`, checked)
          }
        />
      </SectionRow>
      <SectionRow
        label={t("channels.signalSendReadReceipts")}
        description={t("channels.signalSendReadReceiptsDesc")}
      >
        <Switch
          checked={sendReadReceipts}
          onCheckedChange={(checked: boolean) =>
            update(`${pathPrefix}.sendReadReceipts`, checked)
          }
        />
      </SectionRow>
      <SectionRow
        label={t("channels.allowFrom")}
        description={t("channels.allowFromDesc")}
      >
        <Input
          value={allowFrom.join(", ")}
          onChange={(val: string) =>
            update(`${pathPrefix}.allowFrom`, parseCommaSeparated(val))
          }
          style={SECTION_CONTROL_STYLE}
          placeholder="+1234567890"
        />
      </SectionRow>
    </SectionContainer>
  );
};

export default SignalConfig;
