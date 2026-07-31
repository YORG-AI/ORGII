import {
  HOST_DESKTOP,
  type HostDesktop,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { WINDOW_CHROME_TOKENS } from "@src/config/windowChromeTokens";
import { DEFAULT_SIDEBAR_WIDTH } from "@src/store/ui/sidebarAtom";

export interface SetupSidebarLayout {
  panelWidth: number;
  contentTopInset: number;
}

/**
 * Resolves setup-shell dimensions from the same sidebar and window-chrome
 * tokens used by the main application shell.
 */
export function resolveSetupSidebarLayout(
  host: HostDesktop = resolveHostDesktop()
): SetupSidebarLayout {
  return {
    panelWidth: DEFAULT_SIDEBAR_WIDTH,
    contentTopInset:
      host === HOST_DESKTOP.MACOS ? WINDOW_CHROME_TOKENS.titleBarHeight : 0,
  };
}
