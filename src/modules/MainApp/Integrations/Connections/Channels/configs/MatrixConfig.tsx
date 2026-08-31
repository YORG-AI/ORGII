/**
 * Matrix Channel Configuration
 *
 * Decentralized messaging protocol with homeserver-based accounts.
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

const MatrixConfig: React.FC<ChannelConfigProps> = ({
  config,
  update,
  pathPrefix,
}) => {
  const { t } = useTranslation("integrations");

  const homeserverUrl = getNestedString(
    config,
    `${pathPrefix}.homeserverUrl`,
    "https://matrix.org"
  );
  const userId = getNestedString(config, `${pathPrefix}.userId`, "");
  const accessToken = getNestedString(config, `${pathPrefix}.accessToken`, "");
  const password = getNestedString(config, `${pathPrefix}.password`, "");
  const deviceName = getNestedString(config, `${pathPrefix}.deviceName`, "");
  const encryption = getNestedBool(config, `${pathPrefix}.encryption`, false);
  const autoJoin = getNestedString(
    config,
    `${pathPrefix}.autoJoin`,
    "allowlist"
  );
  const allowFrom = getNestedStringArray(config, `${pathPrefix}.allowFrom`);

  return (
    <SectionContainer>
      <SectionRow
        label={t("channels.matrixHomeserver")}
        description={t("channels.matrixHomeserverDesc")}
      >
        <Input
          value={homeserverUrl}
          onChange={(val: string) => update(`${pathPrefix}.homeserverUrl`, val)}
          style={SECTION_CONTROL_STYLE}
          placeholder="https://matrix.org"
        />
      </SectionRow>
      <SectionRow
        label={t("channels.matrixUserId")}
        description={t("channels.matrixUserIdDesc")}
      >
        <Input
          value={userId}
          onChange={(val: string) => update(`${pathPrefix}.userId`, val)}
          style={SECTION_CONTROL_STYLE}
          placeholder="@bot:matrix.org"
        />
      </SectionRow>
      <SectionRow
        label={t("channels.matrixAccessToken")}
        description={t("channels.matrixAccessTokenDesc")}
      >
        <Input
          value={accessToken}
          onChange={(val: string) => update(`${pathPrefix}.accessToken`, val)}
          style={SECTION_CONTROL_STYLE}
          type="password"
          placeholder="••••••••"
        />
      </SectionRow>
      <SectionRow
        label={t("channels.matrixPassword")}
        description={t("channels.matrixPasswordDesc")}
      >
        <Input
          value={password}
          onChange={(val: string) => update(`${pathPrefix}.password`, val)}
          style={SECTION_CONTROL_STYLE}
          type="password"
          placeholder="••••••••"
        />
      </SectionRow>
      <SectionRow
        label={t("channels.matrixDeviceName")}
        description={t("channels.matrixDeviceNameDesc")}
      >
        <Input
          value={deviceName}
          onChange={(val: string) => update(`${pathPrefix}.deviceName`, val)}
          style={SECTION_CONTROL_STYLE}
          placeholder="ORGII Bot"
        />
      </SectionRow>
      <SectionRow
        label={t("channels.matrixEncryption")}
        description={t("channels.matrixEncryptionDesc")}
      >
        <Switch
          checked={encryption}
          onCheckedChange={(checked: boolean) =>
            update(`${pathPrefix}.encryption`, checked)
          }
        />
      </SectionRow>
      <SectionRow
        label={t("channels.matrixAutoJoin")}
        description={t("channels.matrixAutoJoinDesc")}
      >
        <Input
          value={autoJoin}
          onChange={(val: string) => update(`${pathPrefix}.autoJoin`, val)}
          style={SECTION_CONTROL_STYLE}
          placeholder="allowlist"
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
          placeholder="@user:matrix.org"
        />
      </SectionRow>
    </SectionContainer>
  );
};

export default MatrixConfig;
