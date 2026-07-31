import { describe, expect, it } from "vitest";

import { HOST_DESKTOP } from "@src/config/windowChromeRadius";
import { WINDOW_CHROME_TOKENS } from "@src/config/windowChromeTokens";
import { DEFAULT_SIDEBAR_WIDTH } from "@src/store/ui/sidebarAtom";

import {
  SETUP_WALKTHROUGH_LAYOUT_TOKENS,
  resolveSetupSidebarLayout,
} from "../layoutTokens";

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

  it("uses shared responsive, typography, scrollbar, and motion utilities", () => {
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebar).toContain("md:!flex");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.mobileProgress).toContain(
      "md:hidden"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.contentScroll).toContain(
      "scrollbar-overlay"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.contentScroll).toContain("sm:p-6");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.stepFrame).toContain(
      "animate-fade-in"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.stepFrame).toContain(
      "motion-reduce:animate-none"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid).toBe(
      "max-sm:!grid-cols-1"
    );
  });
});
