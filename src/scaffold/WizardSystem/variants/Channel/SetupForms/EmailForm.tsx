import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import Input from "@src/components/Input";
import Switch from "@src/components/Switch";
import { Mail01Icon, MailSend01Icon } from "@src/icons";
import { CHANNEL_DEFAULTS } from "@src/modules/MainApp/Integrations/Connections/Channels/config";
import {
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import {
  SelectionGrid,
  type SelectionGridOption,
} from "@src/scaffold/WizardSystem/primitives";

import { type ChannelFormProps, getBool, getNumber, getString } from "./types";

const EmailForm: React.FC<ChannelFormProps> = ({ config, onChange }) => {
  const { t } = useTranslation("integrations");
  const defaults = CHANNEL_DEFAULTS.email;
  const [method, setMethod] = useState<"imap" | "smtp">("imap");

  const EMAIL_METHODS: SelectionGridOption[] = [
    { key: "imap", label: "IMAP", icon: Mail01Icon },
    { key: "smtp", label: "SMTP", icon: MailSend01Icon },
  ];

  return (
    <SectionContainer>
      <SectionRow
        label={t("channels.emailProtocol", "Protocol")}
        layout="vertical"
      >
        <SelectionGrid
          options={EMAIL_METHODS}
          selected={method}
          cardVariant="subtle"
          onSelect={(key) => setMethod(key as "imap" | "smtp")}
        />
      </SectionRow>

      {method === "imap" && (
        <>
          <SectionRow label={t("channels.emailImapHost")} required>
            <Input
              value={getString(config, "imapHost")}
              onChange={(val: string) => onChange({ imapHost: val })}
              placeholder="imap.gmail.com"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailImapPort")}>
            <Input
              value={String(getNumber(config, "imapPort", defaults.imapPort))}
              onChange={(val: string) => {
                const num = parseInt(val, 10);
                if (!isNaN(num) && num >= 1 && num <= 65535)
                  onChange({ imapPort: num });
              }}
              placeholder={String(defaults.imapPort)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailUsername")}>
            <Input
              value={getString(config, "imapUsername")}
              onChange={(val: string) => onChange({ imapUsername: val })}
              placeholder="user@gmail.com"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailPassword")}>
            <Input
              value={getString(config, "imapPassword")}
              onChange={(val: string) => onChange({ imapPassword: val })}
              type="password"
              placeholder="******"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailMailbox")}>
            <Input
              value={getString(config, "imapMailbox") || defaults.imapMailbox}
              onChange={(val: string) => onChange({ imapMailbox: val })}
              placeholder={defaults.imapMailbox}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailImapSsl")}>
            <Switch
              checked={getBool(config, "imapUseSsl", defaults.imapUseSsl)}
              onCheckedChange={(checked: boolean) =>
                onChange({ imapUseSsl: checked })
              }
            />
          </SectionRow>
        </>
      )}

      {method === "smtp" && (
        <>
          <SectionRow label={t("channels.emailSmtpHost")} required>
            <Input
              value={getString(config, "smtpHost")}
              onChange={(val: string) => onChange({ smtpHost: val })}
              placeholder="smtp.gmail.com"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailSmtpPort")}>
            <Input
              value={String(getNumber(config, "smtpPort", defaults.smtpPort))}
              onChange={(val: string) => {
                const num = parseInt(val, 10);
                if (!isNaN(num) && num >= 1 && num <= 65535)
                  onChange({ smtpPort: num });
              }}
              placeholder={String(defaults.smtpPort)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailUsername")}>
            <Input
              value={getString(config, "smtpUsername")}
              onChange={(val: string) => onChange({ smtpUsername: val })}
              placeholder="user@gmail.com"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailPassword")}>
            <Input
              value={getString(config, "smtpPassword")}
              onChange={(val: string) => onChange({ smtpPassword: val })}
              type="password"
              placeholder="******"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailSmtpTls")}>
            <Switch
              checked={getBool(config, "smtpUseTls", defaults.smtpUseTls)}
              onCheckedChange={(checked: boolean) =>
                onChange({ smtpUseTls: checked })
              }
            />
          </SectionRow>
          <SectionRow label={t("channels.emailFromAddress")} required>
            <Input
              value={getString(config, "fromAddress")}
              onChange={(val: string) => onChange({ fromAddress: val })}
              placeholder="agent@example.com"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.emailAutoReply")}>
            <Switch
              checked={getBool(
                config,
                "autoReplyEnabled",
                defaults.autoReplyEnabled
              )}
              onCheckedChange={(checked: boolean) =>
                onChange({ autoReplyEnabled: checked })
              }
            />
          </SectionRow>
          <SectionRow label={t("channels.emailPollInterval")}>
            <Input
              value={String(
                getNumber(
                  config,
                  "pollIntervalSeconds",
                  defaults.pollIntervalSeconds
                )
              )}
              onChange={(val: string) => {
                const num = parseInt(val, 10);
                if (!isNaN(num) && num >= 5 && num <= 3600)
                  onChange({ pollIntervalSeconds: num });
              }}
              placeholder={String(defaults.pollIntervalSeconds)}
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
          <SectionRow label={t("channels.allowFrom")}>
            <Input
              value={getString(config, "allowFrom")}
              onChange={(val: string) => onChange({ allowFrom: val })}
              placeholder="user@example.com"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              style={SECTION_CONTROL_STYLE}
            />
          </SectionRow>
        </>
      )}
    </SectionContainer>
  );
};

export default EmailForm;
