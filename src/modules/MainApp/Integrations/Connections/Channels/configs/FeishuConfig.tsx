/**
 * Feishu / Lark Channel Configuration
 */
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import React from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";

import {
  getNestedBool,
  getNestedString,
  getNestedStringArray,
} from "../../../../AgentOrgs/config/osAgent/utils";
import type { ChannelConfigProps } from "../types";
import { parseCommaSeparated } from "../utils";

const DOMAIN_OPTIONS = [
  { label: "Feishu (China)", value: "feishu" },
  { label: "Lark (International)", value: "lark" },
];

const DM_POLICY_OPTIONS = [
  { label: "Open", value: "open" },
  { label: "Allowlist only", value: "allowlist" },
];

const GROUP_POLICY_OPTIONS = [
  { label: "Open", value: "open" },
  { label: "Allowlist only", value: "allowlist" },
  { label: "Disabled", value: "disabled" },
];

const RENDER_MODE_OPTIONS = [
  { label: "Auto", value: "auto" },
  { label: "Plain text", value: "raw" },
  { label: "Card", value: "card" },
];

const FeishuConfig: React.FC<ChannelConfigProps> = ({
  config,
  update,
  pathPrefix,
}) => {
  const { t } = useTranslation("integrations");

  const appId = getNestedString(config, `${pathPrefix}.appId`, "");
  const appSecret = getNestedString(config, `${pathPrefix}.appSecret`, "");
  const encryptKey = getNestedString(config, `${pathPrefix}.encryptKey`, "");
  const domain = getNestedString(config, `${pathPrefix}.domain`, "feishu");
  const dmPolicy = getNestedString(config, `${pathPrefix}.dmPolicy`, "open");
  const groupPolicy = getNestedString(
    config,
    `${pathPrefix}.groupPolicy`,
    "allowlist"
  );
  const requireMention = getNestedBool(
    config,
    `${pathPrefix}.requireMention`,
    true
  );
  const renderMode = getNestedString(
    config,
    `${pathPrefix}.renderMode`,
    "auto"
  );
  const allowFrom = getNestedStringArray(config, `${pathPrefix}.allowFrom`);

  return (
    <SectionContainer>
      {/* Credentials */}
      <SectionRow
        label={t("channels.feishuDomain")}
        description={t("channels.feishuDomainDesc")}
      >
        <Select
          value={domain}
          onChange={(val) => update(`${pathPrefix}.domain`, val)}
          options={DOMAIN_OPTIONS}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("channels.feishuAppId")}
        description={t("channels.feishuAppIdDesc")}
      >
        <Input
          value={appId}
          onChange={(val: string) => update(`${pathPrefix}.appId`, val)}
          style={SECTION_CONTROL_STYLE}
          placeholder="cli_xxxxxxxx"
        />
      </SectionRow>
      <SectionRow
        label={t("channels.feishuAppSecret")}
        description={t("channels.feishuAppSecretDesc")}
      >
        <Input
          value={appSecret}
          onChange={(val: string) => update(`${pathPrefix}.appSecret`, val)}
          style={SECTION_CONTROL_STYLE}
          type="password"
          placeholder="••••••••"
        />
      </SectionRow>
      <SectionRow
        label={t("channels.feishuEncryptKey")}
        description={t("channels.feishuEncryptKeyDesc")}
      >
        <Input
          value={encryptKey}
          onChange={(val: string) => update(`${pathPrefix}.encryptKey`, val)}
          style={SECTION_CONTROL_STYLE}
          type="password"
          placeholder="••••••••"
        />
      </SectionRow>

      {/* Access control */}
      <SectionRow
        label={t("channels.feishuDmPolicy")}
        description={t("channels.feishuDmPolicyDesc")}
      >
        <Select
          value={dmPolicy}
          onChange={(val) => update(`${pathPrefix}.dmPolicy`, val)}
          options={DM_POLICY_OPTIONS}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("channels.feishuGroupPolicy")}
        description={t("channels.feishuGroupPolicyDesc")}
      >
        <Select
          value={groupPolicy}
          onChange={(val) => update(`${pathPrefix}.groupPolicy`, val)}
          options={GROUP_POLICY_OPTIONS}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>
      <SectionRow
        label={t("channels.feishuRequireMention")}
        description={t("channels.feishuRequireMentionDesc")}
      >
        <Switch
          checked={requireMention}
          onCheckedChange={(checked: boolean) =>
            update(`${pathPrefix}.requireMention`, checked)
          }
        />
      </SectionRow>

      {/* Rendering */}
      <SectionRow
        label={t("channels.feishuRenderMode")}
        description={t("channels.feishuRenderModeDesc")}
      >
        <Select
          value={renderMode}
          onChange={(val) => update(`${pathPrefix}.renderMode`, val)}
          options={RENDER_MODE_OPTIONS}
          style={SECTION_CONTROL_STYLE}
        />
      </SectionRow>

      {/* Allowlist */}
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
          placeholder="ou_xxxxxxxx"
        />
      </SectionRow>
    </SectionContainer>
  );
};

export default FeishuConfig;
