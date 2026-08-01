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

  it("uses shared responsive, typography, and reduced-motion utilities", () => {
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.sidebar).toContain("lg:!flex");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.card).toContain("!max-w-screen-2xl");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.hero).toContain("pb-0");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.hero).not.toContain("pb-10");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.mobileProgress).toContain(
      "lg:hidden"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.mainContent).toContain(
      "overflow-y-auto"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.mainContent).toContain("sm:px-8");
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.stepFrame).toContain(
      "animate-fade-in"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.stepFrame).toContain(
      "motion-reduce:animate-none"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.presentationToolbar).toContain(
      "max-w-[900px]"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.nativePreferenceList).toContain(
      "!bg-transparent"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.cinematicPreferenceCard).toContain(
      "setup-preferences-card"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.classicPreferenceCard).toContain(
      "bg-bg-1"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.classicPreferenceControl).toBe(
      "w-full"
    );
    expect(SETUP_WALKTHROUGH_LAYOUT_TOKENS.choiceGrid).toBe(
      "max-sm:!grid-cols-1"
    );
  });
});
