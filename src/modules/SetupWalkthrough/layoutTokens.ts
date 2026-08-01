import {
  HOST_DESKTOP,
  type HostDesktop,
  resolveHostDesktop,
} from "@src/config/windowChromeRadius";
import { WINDOW_CHROME_TOKENS } from "@src/config/windowChromeTokens";
import { TYPOGRAPHY } from "@src/config/workstation/tokens";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";
import { DEFAULT_SIDEBAR_WIDTH } from "@src/store/ui/sidebarAtom";

/**
 * Feature composition tokens for the full-screen setup surface.
 *
 * Reusable controls keep their own visual contracts; this object owns only
 * the setup shell's responsive composition so spacing, motion, and overrides
 * are not rebuilt across JSX and SCSS.
 */
export const SETUP_WALKTHROUGH_LAYOUT_TOKENS = {
  shell: "setup-walkthrough-ambient !overflow-hidden !bg-bg-2 !p-0",
  card: "setup-walkthrough-card !mx-auto !max-h-none !w-full !max-w-screen-2xl !rounded-none !border-0 !bg-transparent !shadow-none",
  sidebar:
    "!hidden !max-w-none !basis-5/12 !shrink-0 !items-stretch !justify-stretch !bg-transparent !p-0 lg:!flex",
  sidebarContent: "relative flex h-full w-full flex-col overflow-hidden",
  brandRow: "flex items-center gap-3",
  brandLogo: "rounded-xl",
  brandCopy: "min-w-0",
  brandTitleRow: "flex items-center gap-2",
  brandTitle: `${TYPOGRAPHY.statistic} tracking-tight text-text-1`,
  brandTag: `${TYPOGRAPHY.badge} uppercase tracking-wide text-text-3`,
  brandDescription: "max-w-52",
  progress: "mt-6",
  progressLabel: `mb-2 flex items-center justify-between gap-3 ${TYPOGRAPHY.contentSubtitle}`,
  progressLabelText: "font-medium text-text-2",
  navigation: "mt-5",
  hero: "relative flex h-full w-full flex-col px-10 pb-0 pt-20 xl:px-20 xl:pt-24",
  heroCopy: "relative z-10 mt-20 max-w-lg xl:mt-24",
  heroTitle:
    "m-0 text-4xl font-semibold leading-tight tracking-tight text-text-1 xl:text-6xl",
  heroBrandAccent: "setup-walkthrough-brand-accent",
  heroDescription:
    "mt-5 max-w-md text-base leading-7 text-text-2 xl:text-lg xl:leading-8",
  heroVisual: "relative mt-auto min-h-72 flex-1",
  heroPlanet: "setup-walkthrough-planet absolute inset-x-0 bottom-0 h-40",
  heroMascot:
    "setup-walkthrough-mascot absolute bottom-10 left-1/2 h-64 w-auto -translate-x-1/2 object-contain xl:h-80",
  main: "!min-w-0 !bg-transparent !p-0",
  mainContent:
    "relative flex h-full w-full flex-col items-center justify-center overflow-y-auto px-5 py-16 sm:px-8 lg:px-10 xl:px-12",
  mobileProgress: `absolute left-5 top-16 flex items-center gap-3 text-text-1 sm:left-10 lg:hidden ${TYPOGRAPHY.secondary}`,
  mobileProgressTitle: "font-semibold tracking-tight",
  contentScroll: "contents",
  stepFrame:
    "animate-fade-in flex w-full justify-center motion-reduce:animate-none",
  presentationStack: "flex w-full flex-col items-center gap-3",
  presentationToolbar: `${DETAIL_PANEL_TOKENS.contentWidth} flex justify-end`,
  presentationField: "w-full max-w-xs",
  nativePreferenceList: "!bg-transparent",
  classicPreferenceCard:
    "w-full max-w-2xl rounded-2xl border border-border-1 bg-bg-1 shadow-sm",
  classicPreferenceContent: "!max-w-none gap-5 px-6 py-6 sm:px-8 [&>div]:gap-4",
  classicPreferenceList:
    "!rounded-none !border-0 !bg-transparent !px-0 [&>.section-layout-row]:after:!inset-x-0",
  classicPreferenceRow: "!min-h-0 !py-3",
  classicPreferenceControl: "w-full",
  cinematicPreferenceCard:
    "setup-preferences-card w-full max-w-2xl rounded-3xl p-6 sm:p-8",
  cinematicPreferenceContent:
    "!max-w-none gap-7 [&_h1]:!text-xl [&_h1]:!leading-7 [&>header]:items-center [&>header]:gap-4 [&>div]:gap-5",
  cinematicPreferenceList:
    "!flex !flex-col !gap-3 !border-0 !bg-transparent !p-0 [&>.section-layout-row]:after:!hidden",
  cinematicPreferenceRow:
    "setup-preference-row !min-h-16 rounded-xl !px-4 !py-3 sm:!min-h-20 sm:!px-5",
  cinematicPreferenceLabel: "flex items-center gap-3 font-medium text-text-1",
  cinematicPreferenceIcon:
    "flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-text-2",
  cinematicPreferenceControl: "w-full sm:w-56",
  cinematicPreferenceCta: "setup-preference-cta !h-12 !rounded-xl",
  cinematicPreferenceSecondary: "self-center",
  footer: "",
  choiceGrid: "max-sm:!grid-cols-1",
} as const;

export const SETUP_WALKTHROUGH_HERO_PANEL_STYLE: React.CSSProperties = {
  flex: "0 0 46%",
  width: "46%",
  maxWidth: "none",
};

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
