import { createInstance } from "i18next";
import { initReactI18next } from "react-i18next";

import enMobileRemote from "@src/i18n/locales/en/mobileRemote.json";
import zhMobileRemote from "@src/i18n/locales/zh/mobileRemote.json";

const enSupport = {
  common: {
    actions: {
      close: "Close",
      sort: "Sort",
      back: "Back",
      search: "Search",
      add: "Add",
    },
    tooltips: {
      startVoiceInput: "Start voice input",
      cancelRecording: "Cancel recording",
      stopAndTranscribe: "Stop and transcribe",
    },
    pagination: {
      round: "Round {{current}}",
      previousRound: "Previous round",
      nextRound: "Next round",
      latestRound: "Latest round",
    },
    selectors: {
      modelProperties: {
        settings: "Model settings",
        model: "Model",
        effort: "Effort",
        speed: "Speed",
        standard: "Standard",
        fast: "Fast",
        thinking: "Thinking",
        on: "On",
        off: "Off",
        default: "Default",
      },
    },
  },
  sessions: {
    creator: {
      model: "Model",
      selectModel: "Select model",
      switchModel: "Switch model",
    },
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
  selectors: enSupport.common.selectors,
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
  common: {
    actions: {
      close: "关闭",
      sort: "排序",
      back: "返回",
      search: "搜索",
      add: "添加",
    },
    tooltips: {
      startVoiceInput: "开始语音输入",
      cancelRecording: "取消录制",
      stopAndTranscribe: "停止并转录",
    },
    pagination: {
      round: "第 {{current}} 轮",
      previousRound: "上一轮",
      nextRound: "下一轮",
      latestRound: "最新轮次",
    },
    selectors: {
      modelProperties: {
        settings: "模型设置",
        model: "模型",
        effort: "推理强度",
        speed: "速度",
        standard: "标准",
        fast: "快速",
        thinking: "思考",
        on: "开",
        off: "关",
        default: "默认",
      },
    },
  },
  sessions: {
    creator: {
      model: "模型",
      selectModel: "选择模型",
      switchModel: "切换模型",
    },
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
  selectors: zhSupport.common.selectors,
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
    // Match desktop i18n: shared components call t("actions.*") and
    // t("selectors.*") without an explicit namespace.
    defaultNS: "common",
    ns: ["mobileRemote", "common", "sessions"],
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  .then(() => undefined);
