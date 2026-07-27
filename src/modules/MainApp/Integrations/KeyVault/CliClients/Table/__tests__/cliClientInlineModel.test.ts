import { describe, expect, it } from "vitest";

import {
  hasCliClientActions,
  resolveCliClientInlineTab,
} from "../cliClientInlineModel";
import { CLI_CLIENT_INLINE_TAB } from "../cliClientInlineTypes";

describe("CLI client inline model", () => {
  it("selects the action collection for the installed state", () => {
    expect(
      hasCliClientActions({
        installed: false,
        installMethods: [{ id: "npm", label: "npm", command: "npm i" }],
        uninstallMethods: [],
      })
    ).toBe(true);
    expect(
      hasCliClientActions({
        installed: true,
        installMethods: [{ id: "npm", label: "npm", command: "npm i" }],
        uninstallMethods: [],
      })
    ).toBe(false);
  });

  it("falls back when the requested tab is disabled or missing", () => {
    const tabs = [
      { key: CLI_CLIENT_INLINE_TAB.STATUS },
      { key: CLI_CLIENT_INLINE_TAB.SUBSCRIPTIONS },
      { key: CLI_CLIENT_INLINE_TAB.CLIENT, disabled: true },
    ];
    expect(
      resolveCliClientInlineTab(CLI_CLIENT_INLINE_TAB.SUBSCRIPTIONS, tabs)
    ).toBe(CLI_CLIENT_INLINE_TAB.SUBSCRIPTIONS);
    expect(resolveCliClientInlineTab(CLI_CLIENT_INLINE_TAB.CLIENT, tabs)).toBe(
      CLI_CLIENT_INLINE_TAB.STATUS
    );
  });
});
