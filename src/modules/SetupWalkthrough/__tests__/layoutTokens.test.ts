import { describe, expect, it } from "vitest";

import { HOST_DESKTOP } from "@src/config/windowChromeRadius";
import { WINDOW_CHROME_TOKENS } from "@src/config/windowChromeTokens";
import { DEFAULT_SIDEBAR_WIDTH } from "@src/store/ui/sidebarAtom";

import { resolveSetupSidebarLayout } from "../layoutTokens";

describe("setup walkthrough layout tokens", () => {
  it("reserves the shared titlebar height below macOS traffic lights", () => {
    expect(resolveSetupSidebarLayout(HOST_DESKTOP.MACOS)).toEqual({
      panelWidth: DEFAULT_SIDEBAR_WIDTH,
      contentTopInset: WINDOW_CHROME_TOKENS.titleBarHeight,
    });
  });

  it.each([HOST_DESKTOP.WINDOWS, HOST_DESKTOP.LINUX])(
    "does not add a native traffic-light inset on %s",
    (host) => {
      expect(resolveSetupSidebarLayout(host)).toEqual({
        panelWidth: DEFAULT_SIDEBAR_WIDTH,
        contentTopInset: 0,
      });
    }
  );
});
