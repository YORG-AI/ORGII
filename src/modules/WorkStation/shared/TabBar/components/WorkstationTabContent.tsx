import type { TFunction } from "i18next";
import React from "react";
import { useTranslation } from "react-i18next";

import { TabLabelRowScrim } from "@src/components/TabPill/TabLabelRowScrim";
import {
  getStatusColor,
  getStatusColorForFile,
  getStatusLetterForFile,
} from "@src/config/gitStatus";
import {
  HugeiconsIcon,
  LockIcon as Lock,
  MoveLeftIcon as MoveHorizontal,
} from "@src/icons";
import type { GitFileInfo } from "@src/store/git";
import {
  isPlaceholderBrowserSessionTitle,
  translatePlaceholderBrowserSessionTitle,
} from "@src/store/workstation/browser/tabs";
import {
  CODE_EDITOR_MAIN_TERMINAL_TAB_ID,
  resolveProjectManagerTabTitle,
} from "@src/store/workstation/tabs";

import type { WorkStationTab } from "../types";
import { WorkstationTabIcon } from "./WorkstationTabIcon";

export function getWorkstationTabDisplayTitle(
  tab: WorkStationTab,
  t: TFunction
) {
  if (
    tab.type === "browser-session" &&
    isPlaceholderBrowserSessionTitle(tab.title)
  ) {
    return translatePlaceholderBrowserSessionTitle(tab.title, t);
  }
  if (
    tab.type === "project-dashboard" ||
    tab.type === "project-work-items" ||
    tab.type === "project-linear-projects" ||
    tab.type === "project-linear-work-items"
  ) {
    return resolveProjectManagerTabTitle(tab, t);
  }
  // Localized titles for the singleton tool tabs.
  switch (tab.type) {
    case "start":
      return t("navigation:routes.launchpad");
    case "search-sessions":
      return t("navigation:workstation.plusMenu.searchSessions");
    case "explorer":
      return t("common:labels.files");
    case "source-control":
      return t("common:actions.review");
    case "terminal":
      if (tab.id === CODE_EDITOR_MAIN_TERMINAL_TAB_ID) {
        return t("common:tabs.terminal");
      }
      break;
  }
  return tab.title;
}

/** Shared visible content for the tab strip and its drag preview. */
export function WorkstationTabContent({
  tab,
  isActive,
  gitInfo = null,
  hideLabel = false,
  showLabelRightScrim = false,
}: {
  tab: WorkStationTab;
  isActive: boolean;
  gitInfo?: GitFileInfo | null;
  hideLabel?: boolean;
  showLabelRightScrim?: boolean;
}) {
  const { t } = useTranslation();
  const titleTextClass = (base: string) =>
    `${base} ${
      tab.type === "git-diff" && tab.data.gitStatusLetter === "D"
        ? "text-danger-6 line-through"
        : tab.type === "file" && gitInfo
          ? getStatusColorForFile(gitInfo.status, gitInfo.staged)
          : isActive
            ? "text-text-1"
            : "text-text-2"
    }`;

  return (
    <>
      {/* Keep icon in-flow so width only comes from the label column; close stays overlay-only. */}
      <div className="flex shrink-0 items-center justify-center">
        <WorkstationTabIcon tab={tab} isActive={isActive} />
      </div>

      {!hideLabel && tab.type === "git-diff" && tab.data.isTimeline ? (
        <div
          className={`relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[13px] ${
            isActive ? "text-text-1" : "text-text-2"
          }`}
        >
          <span className="min-w-0 flex-1 truncate">
            {tab.title} ({String(tab.data.shortSha)})
          </span>
          <HugeiconsIcon
            icon={MoveHorizontal}
            data-icon="move-horizontal"
            size={12}
            className="shrink-0"
          />
          <span className="shrink-0">
            ({String(tab.data.headShortSha || "HEAD")})
          </span>
          <HugeiconsIcon
            icon={Lock}
            data-icon="lock"
            size={11}
            className="shrink-0"
          />
          <TabLabelRowScrim visible={showLabelRightScrim} />
        </div>
      ) : !hideLabel ? (
        <div className="relative flex min-w-0 flex-1 items-center gap-1 overflow-hidden">
          <span
            className={titleTextClass(
              "min-w-0 flex-1 overflow-hidden text-[13px] text-ellipsis whitespace-nowrap"
            )}
          >
            {tab.type === "git-diff"
              ? `${tab.title} (Working Tree)`
              : getWorkstationTabDisplayTitle(tab, t)}
          </span>
          {tab.type === "git-diff" && !!tab.data.gitStatusLetter && (
            <span
              className={`shrink-0 text-[11px] font-bold ${getStatusColor(tab.data.gitStatusLetter as string)}`}
            >
              {String(tab.data.gitStatusLetter)}
            </span>
          )}
          {tab.type === "file" && gitInfo && (
            <span
              className={`shrink-0 text-[11px] font-bold ${getStatusColorForFile(gitInfo.status, gitInfo.staged)}`}
            >
              {getStatusLetterForFile(gitInfo.status, gitInfo.staged)}
            </span>
          )}
          <TabLabelRowScrim visible={showLabelRightScrim} />
        </div>
      ) : null}
    </>
  );
}
