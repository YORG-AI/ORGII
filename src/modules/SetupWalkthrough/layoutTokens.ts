import {
  HOST_DESKTOP,
  type HostDesktop,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { WINDOW_CHROME_TOKENS } from "@src/config/windowChromeTokens";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import { DEFAULT_SIDEBAR_WIDTH } from "@src/store/ui/sidebarAtom";

/**
 * Feature composition tokens for the full-screen setup surface.
 *
 * Reusable controls keep their own visual contracts; this object owns only
 * the setup shell's responsive composition so spacing, motion, and overrides
 * are not rebuilt across JSX and SCSS.
 */
export const SETUP_WALKTHROUGH_LAYOUT_TOKENS = {
  shell: "!overflow-hidden !bg-bg-2 !p-0",
  card: "!max-h-none !max-w-none !rounded-none !border-0 !shadow-none",
  sidebar:
    "!hidden !shrink-0 !items-stretch !justify-start !gap-0 !border-r !border-border-1 !bg-bg-1 !px-4 !pb-4 !pt-4 md:!flex",
  sidebarContent: "flex h-full w-full flex-col",
  brandRow: "flex items-start gap-3",
  brandLogo: "rounded-full",
  brandCopy: "min-w-0",
  brandTitleRow: "flex items-center gap-2",
  brandTitle: `${TYPOGRAPHY.statistic} tracking-tight text-text-1`,
  brandTag: `${TYPOGRAPHY.badge} uppercase tracking-wide text-text-3`,
  brandDescription: "max-w-52",
  progress: "mt-6",
  progressLabel: `mb-2 flex items-center justify-between gap-3 ${TYPOGRAPHY.contentSubtitle}`,
  progressLabelText: "font-medium text-text-2",
  navigation: "mt-5",
  main: "!min-w-0 !bg-bg-2",
  mainContent: "flex h-full w-full flex-col overflow-hidden",
  mobileProgress: `flex flex-none items-center justify-between gap-3 border-b border-border-1 bg-bg-1 px-5 py-3 text-text-3 sm:px-6 md:hidden ${TYPOGRAPHY.secondary}`,
  mobileProgressTitle: "font-medium text-primary-6",
  contentScroll:
    "scrollbar-overlay relative flex min-h-0 flex-1 flex-col overflow-y-auto bg-bg-2 p-5 sm:p-6 md:px-10 md:py-9",
  stepFrame:
    "animate-fade-in flex min-h-full w-full flex-col motion-reduce:animate-none",
  footer: "h-16 !border-border-1 !bg-bg-2 !px-5 !shadow-none sm:!px-6 md:!px-8",
  choiceGrid: "max-sm:!grid-cols-1",
} as const;

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
