import DingTalkForm from "./DingTalkForm";
import DiscordForm from "./DiscordForm";
import EmailForm from "./EmailForm";
import FeishuForm from "./FeishuForm";
import GoogleChatForm from "./GoogleChatForm";
import IMessageForm from "./IMessageForm";
import LineForm from "./LineForm";
import MSTeamsForm from "./MSTeamsForm";
import MatrixForm from "./MatrixForm";
import SignalForm from "./SignalForm";
import SlackForm from "./SlackForm";
import TelegramForm from "./TelegramForm";
import WeChatForm from "./WeChatForm";
import WeComForm from "./WeComForm";
import WhatsAppForm from "./WhatsAppForm";
import ZaloForm from "./ZaloForm";
import type { ChannelFormComponent } from "./types";

export const CHANNEL_FORMS: Record<string, ChannelFormComponent> = {
  telegram: TelegramForm,
  discord: DiscordForm,
  slack: SlackForm,
  whatsapp: WhatsAppForm,
  imessage: IMessageForm,
  signal: SignalForm,
  feishu: FeishuForm,
  dingtalk: DingTalkForm,
  zalo: ZaloForm,
  line: LineForm,
  msteams: MSTeamsForm,
  matrix: MatrixForm,
  googlechat: GoogleChatForm,
  weixin: WeChatForm,
  wecom: WeComForm,
  email: EmailForm,
};

export function canSubmitChannel(
  channelType: string,
  config: Record<string, unknown>
): boolean {
  const hasValue = (key: string) => {
    const val = config[key];
    return typeof val === "string" && val.trim().length > 0;
  };

  switch (channelType) {
    case "telegram":
      return hasValue("token");
    case "discord":
      return hasValue("token");
    case "whatsapp":
      return true;
    case "feishu":
      return hasValue("appId") && hasValue("appSecret");
    case "dingtalk":
      return hasValue("clientId") && hasValue("clientSecret");
    case "email":
      return hasValue("imapHost") && hasValue("smtpHost");
    case "slack":
      return hasValue("botToken") && hasValue("appToken");
    case "imessage":
      return hasValue("serverUrl") && hasValue("password");
    case "signal":
      return hasValue("phoneNumber");
    case "zalo":
      return hasValue("botToken");
    case "line":
      return hasValue("channelAccessToken") && hasValue("channelSecret");
    case "msteams":
      return hasValue("appId") && hasValue("appPassword");
    case "matrix":
      return (
        hasValue("homeserverUrl") &&
        (hasValue("accessToken") || hasValue("password"))
      );
    case "googlechat":
      return hasValue("serviceAccountKey");
    case "weixin":
      return hasValue("token") && hasValue("botAccountId");
    case "wecom":
      return hasValue("botId") && hasValue("secret");
    default:
      return false;
  }
}

export type { ChannelFormProps } from "./types";
