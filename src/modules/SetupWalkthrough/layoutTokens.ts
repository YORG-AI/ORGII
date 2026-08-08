import { TYPOGRAPHY } from "@src/config/workstation/tokens";

/**
 * Feature composition tokens for the full-screen setup surface.
 *
 * Reusable controls keep their own visual contracts; this object owns only
 * the setup shell's responsive composition so spacing, motion, and overrides
 * are not rebuilt across JSX and SCSS.
 */
export const SETUP_WALKTHROUGH_LAYOUT_TOKENS = {
  shell:
    "setup-walkthrough-ambient !flex !items-center !justify-center !overflow-hidden !bg-bg-2 !p-0",
  card: "setup-walkthrough-card !mx-auto !h-5/6 !max-h-none !w-full !max-w-6xl !overflow-hidden !rounded-2xl !border !border-solid !border-border-1 !bg-bg-1 !shadow-xl",
  heroBrandRow: "flex items-center gap-3",
  brandLogo: "rounded-xl",
  brandTitle: `${TYPOGRAPHY.statistic} tracking-tight text-text-1`,
  sidebar:
    "setup-walkthrough-preview-panel !hidden !max-w-none !basis-5/12 !shrink-0 !items-stretch !justify-stretch !p-0 sm:!flex",
  sidebarContent:
    "relative flex h-full w-full flex-col overflow-hidden sm:z-10",
  hero: "relative flex h-full w-full flex-col px-8 pb-0 pt-8 lg:px-10 lg:pt-10",
  heroCopy: "relative z-10 mt-10 max-w-lg lg:mt-14",
  heroTitle:
    "m-0 text-3xl font-semibold leading-tight tracking-tight text-text-1 xl:text-4xl",
  heroBrandAccent: "setup-walkthrough-brand-accent",
  heroDescription:
    "mt-4 max-w-md text-sm leading-6 text-text-2 xl:text-base xl:leading-7",
  heroVisual: "relative mt-auto min-h-64 flex-1",
  heroPlanet: "setup-walkthrough-planet absolute bottom-0 h-40",
  heroMascot:
    "setup-walkthrough-mascot absolute bottom-8 left-1/2 h-56 w-auto -translate-x-1/2 object-contain xl:h-64",
  appPreviewWrap: "flex h-full items-end pb-8",
  main: "setup-walkthrough-main-panel !min-w-0 !p-0",
  mainContent:
    "relative flex h-full w-full flex-col items-center justify-center overflow-y-auto px-5 py-16 sm:px-8 lg:px-10 xl:px-12",
  mobileBrand: `absolute left-5 top-16 flex items-center gap-3 text-text-1 sm:left-10 lg:hidden ${TYPOGRAPHY.secondary}`,
  mobileBrandTitle: "font-semibold tracking-tight",
  stepFrame:
    "animate-fade-in flex w-full justify-center motion-reduce:animate-none",
  preferenceContent: "!max-w-none gap-5 [&>div]:gap-4",
  preferenceList:
    "!rounded-none !border-0 !bg-transparent !px-0 [&>.section-layout-row]:after:!inset-x-0",
  preferenceRow: "!min-h-14 !py-2.5",
  preferenceControl: "w-full @[480px]:w-56",
  choiceGrid: "max-sm:!grid-cols-1",
} as const;

export const SETUP_APPLICATION_PREVIEW_TOKENS = {
  root: "setup-walkthrough-app-preview mx-auto w-full max-w-md select-none overflow-hidden rounded-xl border border-border-1 bg-bg-1 text-xs text-text-1 shadow-lg",
  windowBar:
    "relative flex h-7 items-center gap-1.5 border-b border-border-1 bg-bg-2 px-3",
  windowDot: "h-1.5 w-1.5 rounded-full bg-fill-4",
  windowTitle: "absolute left-1/2 -translate-x-1/2 font-medium text-text-3",
  body: "flex h-52 min-h-0 bg-bg-1",
  navigation:
    "flex w-12 shrink-0 flex-col items-center border-r border-border-1 bg-bg-2 py-2",
  navigationBrand: "mb-1 flex items-center justify-center text-text-1",
  navigationList:
    "mt-1 flex flex-col items-center gap-1 border-t border-border-1 pt-1.5",
  navigationButton: "!h-7 !w-7 !p-0 !text-text-3",
  navigationButtonSelected: "!h-7 !w-7 !bg-primary-1 !p-0 !text-primary-6",
  contentArea: "grid min-w-0 flex-1 grid-cols-1 overflow-hidden",
  contentAreaSplit: "grid min-w-0 flex-1 grid-cols-2 overflow-hidden",
  workspace: "relative flex min-w-0 overflow-hidden flex-col bg-bg-1",
  filesToggle:
    "!absolute !right-2 !top-0.5 !z-10 !h-6 !w-6 !rounded-md !text-text-3",
  workspacePanel:
    "animate-fade-in flex min-h-0 flex-1 flex-col items-center justify-center px-5 py-4 motion-reduce:animate-none",
  agentHeading: "mb-3 block text-center text-sm font-semibold text-text-1",
  composer: "!mx-auto !w-full !max-w-xs !gap-2 !p-2",
  composerPrompt: "truncate px-1 py-1 text-left text-text-3",
  composerBar: "flex items-center justify-between",
  summaryHeading:
    "mb-3 flex items-center justify-center gap-2 text-sm text-text-1",
  summaryList: "mx-auto flex w-full max-w-xs flex-col gap-1.5",
  summaryRow:
    "flex min-w-0 items-center gap-2 rounded-lg border border-border-1 bg-bg-2 px-2.5 py-2",
  summaryRowText:
    "flex min-w-0 flex-1 flex-col text-left [&>strong]:truncate [&>span]:truncate [&>span]:text-text-3",
  codePanel:
    "animate-fade-in flex min-w-0 overflow-hidden border-l border-border-1 bg-bg-1 motion-reduce:animate-none",
  codeEditor:
    "flex min-w-0 flex-1 flex-col justify-evenly overflow-hidden py-2 text-left font-mono",
  codeLine:
    "flex items-start gap-1 whitespace-nowrap px-2 text-text-3 [&>code]:min-w-0 [&>code]:flex-1 [&>code]:text-left [&>span]:w-4 [&>span]:shrink-0 [&>span]:text-right [&>span]:text-text-4",
} as const;

export const SETUP_WALKTHROUGH_HERO_PANEL_STYLE: React.CSSProperties = {
  flex: "0 0 43%",
  width: "43%",
  maxWidth: "none",
};
