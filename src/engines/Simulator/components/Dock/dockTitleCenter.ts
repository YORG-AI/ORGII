/**
 * Dock-aligned title bar center: icon + label for Workstation and simulator AppType.
 * Icons match Dock (My Station) and DockReplayControl / getAppById (Chat).
 */
import type { TFunction } from "i18next";

import {
  CodeXmlIcon,
  DeliveryBox01Icon,
  type IconSvgElement,
  InternetIcon,
  MonitorDotIcon,
  Package01Icon,
} from "@src/icons";

import { APP_TYPE_PROJECT, AppType } from "../../types/appTypes";
import { BACKGROUND_TASKS_DOCK_APP, getAppById } from "./config";

export function getWorkStationStationTitleCenter(
  appMode: string,
  t: TFunction<"navigation">
): { icon: IconSvgElement; label: string } {
  switch (appMode) {
    case "code":
      return { icon: CodeXmlIcon, label: t("labels.codeEditor") };
    case "browser":
      return { icon: InternetIcon, label: t("labels.browser") };
    case "chat":
      return { icon: Package01Icon, label: t("labels.session") };
    case "project":
      return { icon: DeliveryBox01Icon, label: t("labels.projectManager") };
    case "other":
      return { icon: MonitorDotIcon, label: t("labels.other") };
    default:
      return { icon: CodeXmlIcon, label: t("labels.codeEditor") };
  }
}

export function getSimulatorDockTitleCenter(
  appType: AppType | null,
  t: TFunction<"navigation">
): { icon: IconSvgElement | null; label: string } {
  if (appType == null) {
    return { icon: null, label: "" };
  }

  const dockApp = getAppById(appType);
  const icon = dockApp?.icon ?? CodeXmlIcon;

  switch (appType) {
    case AppType.CODE_EDITOR:
      return { icon, label: t("labels.codeEditor") };
    case AppType.BROWSER:
      return { icon, label: t("labels.browser") };
    case AppType.CHANNELS:
      return { icon, label: t("labels.session") };
    case APP_TYPE_PROJECT:
      return { icon, label: t("labels.projectManager") };
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
  icon: IconSvgElement | null;
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
  const icon = dockApp?.icon ?? CodeXmlIcon;
  return {
    icon,
    label: dockApp?.name ?? "Other",
  };
}
