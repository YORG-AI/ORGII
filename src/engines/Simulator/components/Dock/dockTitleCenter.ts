/**
 * Dock-aligned title bar center: icon + label for Workstation and simulator AppType.
 * Icons match Dock (My Station) and DockReplayControl / getAppById (Chat).
 */
import type { TFunction } from "i18next";
import type { LucideIcon } from "lucide-react";
import { Chromium, Code, ListTodo, MonitorDot, Package2 } from "lucide-react";

import { APP_TYPE_PROJECT, AppType } from "../../types/appTypes";
import { BACKGROUND_TASKS_DOCK_APP, getAppById } from "./config";

export function getWorkStationStationTitleCenter(
  appMode: string,
  t: TFunction<"navigation">
): { icon: LucideIcon; label: string } {
  switch (appMode) {
    case "code":
      return { icon: Code, label: t("labels.codeEditor") };
    case "browser":
      return { icon: Chromium, label: t("labels.browser") };
    case "chat":
      return { icon: Package2, label: t("labels.session") };
    case "project":
      return { icon: ListTodo, label: t("labels.projectManager") };
    case "other":
      return { icon: MonitorDot, label: t("labels.other") };
    default:
      return { icon: Code, label: t("labels.codeEditor") };
  }
}

export function getSimulatorDockTitleCenter(
  appType: AppType | null,
  t: TFunction<"navigation">
): { icon: LucideIcon | null; label: string } {
  if (appType == null) {
    return { icon: null, label: "" };
  }

  const dockApp = getAppById(appType);
  const icon = dockApp?.icon ?? Code;

  switch (appType) {
    case AppType.CODE_EDITOR:
      return { icon, label: t("labels.codeEditor") };
    case AppType.BROWSER:
      return { icon, label: t("labels.browser") };
    case AppType.CHANNELS:
      return { icon, label: t("labels.session") };
    case APP_TYPE_PROJECT:
      return { icon: icon ?? ListTodo, label: t("labels.projectManager") };
    case AppType.DIFF:
      return { icon, label: t("labels.diff") };
    case AppType.BACKGROUND_TASKS:
      return {
        icon: BACKGROUND_TASKS_DOCK_APP.icon,
        label: t("labels.backgroundTasks"),
      };
    default:
      return { icon, label: dockApp?.name ?? t("labels.other") };
  }
}

/** Same icons as the dock; labels are fixed English from `DOCK_APPS` (not i18n). */
export function getSimulatorDockTitleCenterEnglish(appType: AppType | null): {
  icon: LucideIcon | null;
  label: string;
} {
  if (appType == null) {
    return { icon: null, label: "" };
  }

  if (appType === AppType.BACKGROUND_TASKS) {
    return {
      icon: BACKGROUND_TASKS_DOCK_APP.icon,
      label: BACKGROUND_TASKS_DOCK_APP.name,
    };
  }

  const dockApp = getAppById(appType);
  const icon = dockApp?.icon ?? Code;
  return {
    icon,
    label: dockApp?.name ?? "Other",
  };
}
