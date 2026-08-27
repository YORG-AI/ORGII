/**
 * Email Channel Configuration (IMAP + SMTP)
 */
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import React from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import NumberInput from "@src/components/NumberInput";
import Switch from "@src/components/Switch";
import { useDraftNumber } from "@src/hooks/ui";

import {
  getNestedBool,
  getNestedNumber,
  getNestedString,
  getNestedStringArray,
} from "../../../../AgentOrgs/config/osAgent/utils";
import type { ChannelConfigProps } from "../types";
import { parseCommaSeparated } from "../utils";

const EmailConfig: React.FC<ChannelConfigProps> = ({
  config,
  update,
  pathPrefix,
}) => {
  const { t } = useTranslation("integrations");

  // IMAP
  const imapHost = getNestedString(config, `${pathPrefix}.imapHost`, "");
  const imapPort = getNestedNumber(config, `${pathPrefix}.imapPort`, 993);
  const imapUsername = getNestedString(
    config,
    `${pathPrefix}.imapUsername`,
    ""
  );
  const imapPassword = getNestedString(
    config,
    `${pathPrefix}.imapPassword`,
    ""
  );
  const imapMailbox = getNestedString(
    config,
    `${pathPrefix}.imapMailbox`,
    "INBOX"
  );
  const imapUseSsl = getNestedBool(config, `${pathPrefix}.imapUseSsl`, true);

  // SMTP
  const smtpHost = getNestedString(config, `${pathPrefix}.smtpHost`, "");
  const smtpPort = getNestedNumber(config, `${pathPrefix}.smtpPort`, 587);
  const smtpUsername = getNestedString(
    config,
    `${pathPrefix}.smtpUsername`,
    ""
  );
  const smtpPassword = getNestedString(
    config,
    `${pathPrefix}.smtpPassword`,
    ""
  );
  const smtpUseTls = getNestedBool(config, `${pathPrefix}.smtpUseTls`, true);

  // Behavior
  const fromAddress = getNestedString(config, `${pathPrefix}.fromAddress`, "");
  const autoReply = getNestedBool(
    config,
    `${pathPrefix}.autoReplyEnabled`,
    true
  );
  const pollInterval = getNestedNumber(
    config,
    `${pathPrefix}.pollIntervalSeconds`,
    30
  );
  const allowFrom = getNestedStringArray(config, `${pathPrefix}.allowFrom`);

  const imapPortDraft = useDraftNumber({
    value: imapPort,
    min: 1,
    max: 65535,
    onChange: (val) => update(`${pathPrefix}.imapPort`, val),
  });

  const smtpPortDraft = useDraftNumber({
    value: smtpPort,
    min: 1,
    max: 65535,
    onChange: (val) => update(`${pathPrefix}.smtpPort`, val),
  });

  return (
    <>
      {/* IMAP */}
      <SectionContainer>
        <SectionRow
          label={t("channels.emailImapHost")}
          description={t("channels.emailImapHostDesc")}
        >
          <Input
            value={imapHost}
            onChange={(val: string) => update(`${pathPrefix}.imapHost`, val)}
            style={SECTION_CONTROL_STYLE}
            placeholder="imap.gmail.com"
          />
        </SectionRow>
        <SectionRow label={t("channels.emailImapPort")}>
          <Input
            value={imapPortDraft.displayValue}
            onChange={imapPortDraft.onInputChange}
            onBlur={imapPortDraft.onInputBlur}
            style={SECTION_CONTROL_STYLE}
            placeholder="993"
          />
        </SectionRow>
        <SectionRow label={t("channels.emailUsername")}>
          <Input
            value={imapUsername}
            onChange={(val: string) =>
              update(`${pathPrefix}.imapUsername`, val)
            }
            style={SECTION_CONTROL_STYLE}
            placeholder="user@gmail.com"
          />
        </SectionRow>
        <SectionRow label={t("channels.emailPassword")}>
          <Input
            value={imapPassword}
            onChange={(val: string) =>
              update(`${pathPrefix}.imapPassword`, val)
            }
            style={SECTION_CONTROL_STYLE}
            type="password"
            placeholder="******"
          />
        </SectionRow>
        <SectionRow label={t("channels.emailMailbox")}>
          <Input
            value={imapMailbox}
            onChange={(val: string) => update(`${pathPrefix}.imapMailbox`, val)}
            style={SECTION_CONTROL_STYLE}
            placeholder="INBOX"
          />
        </SectionRow>
        <SectionRow label={t("channels.emailImapSsl")}>
          <Switch
            checked={imapUseSsl}
            onCheckedChange={(checked: boolean) =>
              update(`${pathPrefix}.imapUseSsl`, checked)
            }
          />
        </SectionRow>
      </SectionContainer>

      {/* SMTP */}
      <SectionContainer>
        <SectionRow
          label={t("channels.emailSmtpHost")}
          description={t("channels.emailSmtpHostDesc")}
        >
          <Input
            value={smtpHost}
            onChange={(val: string) => update(`${pathPrefix}.smtpHost`, val)}
            style={SECTION_CONTROL_STYLE}
            placeholder="smtp.gmail.com"
          />
        </SectionRow>
        <SectionRow label={t("channels.emailSmtpPort")}>
          <Input
            value={smtpPortDraft.displayValue}
            onChange={smtpPortDraft.onInputChange}
            onBlur={smtpPortDraft.onInputBlur}
            style={SECTION_CONTROL_STYLE}
            placeholder="587"
          />
        </SectionRow>
        <SectionRow label={t("channels.emailUsername")}>
          <Input
            value={smtpUsername}
            onChange={(val: string) =>
              update(`${pathPrefix}.smtpUsername`, val)
            }
            style={SECTION_CONTROL_STYLE}
            placeholder="user@gmail.com"
          />
        </SectionRow>
        <SectionRow label={t("channels.emailPassword")}>
          <Input
            value={smtpPassword}
            onChange={(val: string) =>
              update(`${pathPrefix}.smtpPassword`, val)
            }
            style={SECTION_CONTROL_STYLE}
            type="password"
            placeholder="******"
          />
        </SectionRow>
        <SectionRow label={t("channels.emailSmtpTls")}>
          <Switch
            checked={smtpUseTls}
            onCheckedChange={(checked: boolean) =>
              update(`${pathPrefix}.smtpUseTls`, checked)
            }
          />
        </SectionRow>
      </SectionContainer>

      {/* Behavior */}
      <SectionContainer>
        <SectionRow
          label={t("channels.emailFromAddress")}
          description={t("channels.emailFromAddressDesc")}
        >
          <Input
            value={fromAddress}
            onChange={(val: string) => update(`${pathPrefix}.fromAddress`, val)}
            style={SECTION_CONTROL_STYLE}
            placeholder="agent@example.com"
          />
        </SectionRow>
        <SectionRow
          label={t("channels.emailAutoReply")}
          description={t("channels.emailAutoReplyDesc")}
        >
          <Switch
            checked={autoReply}
            onCheckedChange={(checked: boolean) =>
              update(`${pathPrefix}.autoReplyEnabled`, checked)
            }
          />
        </SectionRow>
        <SectionRow
          label={t("channels.emailPollInterval")}
          description={t("channels.emailPollIntervalDesc")}
        >
          <NumberInput
            value={pollInterval}
            min={5}
            max={3600}
            step={5}
            controlsPosition="sides"
            onValueChange={(val) => {
              if (val !== undefined)
                update(`${pathPrefix}.pollIntervalSeconds`, val);
            }}
            style={SECTION_CONTROL_STYLE}
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
            placeholder="user@example.com"
          />
        </SectionRow>
      </SectionContainer>
    </>
  );
};

export default EmailConfig;
