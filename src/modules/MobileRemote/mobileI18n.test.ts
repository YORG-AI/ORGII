import { describe, expect, it } from "vitest";

import { mobileI18n, mobileI18nReady } from "./mobileI18n";

describe("mobileI18n", () => {
  it("contains the standalone mobile namespaces in English and Chinese", async () => {
    await mobileI18nReady;
    await mobileI18n.changeLanguage("en");
    expect(mobileI18n.t("welcome.title", { ns: "mobileRemote" })).toBe(
      "Mobile Remote"
    );
    expect(mobileI18n.t("composerAccepted", { ns: "mobileRemote" })).toBe(
      "Sent — waiting for the Agent…"
    );
    expect(mobileI18n.t("auth.signIn", { ns: "mobileRemote" })).toBe(
      "Continue with GitHub"
    );
    expect(
      mobileI18n.t("settings.permissionFull", { ns: "mobileRemote" })
    ).toBe("Full access");
    expect(mobileI18n.t("chat.allow", { ns: "sessions" })).toBe("Allow");

    await mobileI18n.changeLanguage("zh");
    expect(mobileI18n.t("chat.typeMessage", { ns: "sessions" })).toBe(
      "输入消息…"
    );
    expect(mobileI18n.t("composerAccepted", { ns: "mobileRemote" })).toBe(
      "已发送，正在等待 Agent 回复…"
    );
    expect(mobileI18n.t("auth.signIn", { ns: "mobileRemote" })).toBe(
      "使用 GitHub 继续"
    );
    expect(
      mobileI18n.t("settings.permissionFull", { ns: "mobileRemote" })
    ).toBe("完整访问");
    expect(mobileI18n.t("devices.primary", { ns: "mobileRemote" })).toBe(
      "主桌面"
    );
    expect(mobileI18n.t("actions.close", { ns: "common" })).toBe("关闭");
    expect(mobileI18n.t("actions.back")).toBe("返回");
    expect(mobileI18n.t("actions.search")).toBe("搜索");
    expect(mobileI18n.t("selectors.modelProperties.model")).toBe("模型");
  });

  it("resolves shared desktop component keys via the common default namespace", async () => {
    await mobileI18nReady;
    await mobileI18n.changeLanguage("en");
    expect(mobileI18n.t("actions.back")).toBe("Back");
    expect(mobileI18n.t("actions.search")).toBe("Search");
    expect(mobileI18n.t("selectors.modelProperties.settings")).toBe(
      "Model settings"
    );
    expect(mobileI18n.t("pagination.round", { current: 2 })).toBe("Round 2");
    expect(mobileI18n.t("common:tooltips.startVoiceInput")).toBe(
      "Start voice input"
    );
    expect(
      mobileI18n.t("input.voiceErrorPermissionIosPwa", { ns: "sessions" })
    ).toContain("ORGII Mobile");
  });

  it("resolves voice permission copy in Chinese", async () => {
    await mobileI18nReady;
    await mobileI18n.changeLanguage("zh");
    expect(
      mobileI18n.t("input.voiceErrorPermissionIosPwa", { ns: "sessions" })
    ).toContain("ORGII Mobile");
    expect(
      mobileI18n.t("input.voicePermissionSheetTitle", { ns: "sessions" })
    ).toBe("需要麦克风权限");
  });
});
