import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import enMobileRemote from "@src/i18n/locales/en/mobileRemote.json";
import zhMobileRemote from "@src/i18n/locales/zh/mobileRemote.json";

const enSupport = {
  common: { actions: { close: "Close" } },
  sessions: {
    chat: {
      typeMessage: "Type a message…",
      send: "Send",
      permissionPrompt: "Your permission is needed",
      commandConfirmTitle: "Command Requires Approval",
      remoteExecutionNotice: "This action will run on {{desktopName}}.",
      allow: "Allow",
      deny: "Deny",
      alwaysAllow: "Always Allow",
    },
  },
};

const enMobileRemoteResources = {
  ...enMobileRemote,
  rounds: {
    navigationLabel: "Conversation rounds",
    label: "Round {{current}} of {{total}}",
    previous: "Previous",
    next: "Next",
    latest: "Latest",
    incomplete: "Recent rounds only",
    truncated: "Some content was shortened",
  },
};

const zhSupport = {
  common: { actions: { close: "关闭" } },
  sessions: {
    chat: {
      typeMessage: "输入消息…",
      send: "发送",
      permissionPrompt: "需要你的授权",
      commandConfirmTitle: "命令需要审批",
      remoteExecutionNotice: "此操作将在 {{desktopName}} 上运行。",
      allow: "允许",
      deny: "拒绝",
      alwaysAllow: "始终允许",
    },
  },
};

const zhMobileRemoteResources = {
  ...zhMobileRemote,
  rounds: {
    navigationLabel: "会话轮次",
    label: "第 {{current}} / {{total}} 轮",
    previous: "上一轮",
    next: "下一轮",
    latest: "最新",
    incomplete: "仅显示最近轮次",
    truncated: "部分内容已截断",
  },
};

function resolveMobileLanguage(): "en" | "zh" {
  if (typeof navigator === "undefined") return "en";
  const languages = [navigator.language, ...(navigator.languages ?? [])];
  return languages.some((language) => language?.toLowerCase().startsWith("zh"))
    ? "zh"
    : "en";
}

export const mobileI18n = createInstance();

export const mobileI18nReady: Promise<void> = mobileI18n
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        mobileRemote: enMobileRemoteResources,
        common: enSupport.common,
        sessions: enSupport.sessions,
      },
      zh: {
        mobileRemote: zhMobileRemoteResources,
        common: zhSupport.common,
        sessions: zhSupport.sessions,
      },
    },
    lng: resolveMobileLanguage(),
    fallbackLng: "en",
    showSupportNotice: false,
    defaultNS: "mobileRemote",
    ns: ["mobileRemote", "common", "sessions"],
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  .then(() => undefined);
