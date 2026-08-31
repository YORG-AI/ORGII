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
    expect(mobileI18n.t("chat.allow", { ns: "sessions" })).toBe("Allow");

    await mobileI18n.changeLanguage("zh");
    expect(mobileI18n.t("chat.typeMessage", { ns: "sessions" })).toBe(
      "输入消息…"
    );
    expect(mobileI18n.t("composerAccepted", { ns: "mobileRemote" })).toBe(
      "已发送，正在等待 Agent 回复…"
    );
    expect(mobileI18n.t("actions.close", { ns: "common" })).toBe("关闭");
  });
});
