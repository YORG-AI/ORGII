import { useAtom, useAtomValue } from "jotai";
import {
  Infinity as InfinityIcon,
  Layers,
  type LucideIcon,
} from "lucide-react";
import React, { useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";

import DropdownSelectedCheck from "@src/components/Dropdown/DropdownSelectedCheck";
import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
} from "@src/components/Dropdown/tokens";
import Tooltip from "@src/components/Tooltip";
import { SURFACE_TOKENS } from "@src/config/surfaceTokens";
import { getDropdownPanelStyle } from "@src/hooks/dropdown/dropdownPanelStyle";
import { useDropdownEngine } from "@src/hooks/dropdown/useDropdownEngine";
import {
  simulatorEffectiveDockAppAtom,
  simulatorFollowAppLockAtom,
} from "@src/store/ui/simulatorAtom";

import { AppType } from "../../types/appTypes";
import { getSimulatorDockTitleCenterEnglish } from "../Dock/dockTitleCenter";

function getActiveAppIcon(appType: AppType | null): LucideIcon | null {
  return getSimulatorDockTitleCenterEnglish(appType).icon;
}

/**
 * Follow-target picker.
 *
 * Renders as an icon-only dropdown trigger (Infinity for "Agent
 * trajectory", active-app icon for "This app") that opens a panel with
 * the two options — same interaction model as the playback-speed
 * picker. Clicking an option commits the selection and closes.
 *
 * "This app" requires a non-Background-Tasks active app; when there's
 * nothing valid to lock to, that option renders as disabled.
 */
export const FollowModeDropdown: React.FC = () => {
  const { t } = useTranslation("sessions");
  const [followAppLock, setFollowAppLock] = useAtom(simulatorFollowAppLockAtom);
  const activeApp = useAtomValue(simulatorEffectiveDockAppAtom);

  const thisAppDisabled = !activeApp || activeApp === AppType.BACKGROUND_TASKS;
  const isAllApps = !followAppLock;

  const {
    isOpen,
    isPositioned,
    triggerRef,
    panelRef,
    panelPosition,
    toggle,
    close,
  } = useDropdownEngine<HTMLButtonElement>({
    placement: "top",
    align: "right",
    gap: DROPDOWN_PANEL.triggerGapTight,
  });

  const panelPositionStyle = useMemo(
    () => getDropdownPanelStyle(panelPosition),
    [panelPosition]
  );

  const triggerIcon: LucideIcon = isAllApps
    ? InfinityIcon
    : (getActiveAppIcon(activeApp) ?? Layers);

  const handleSelectAgent = useCallback(() => {
    setFollowAppLock(null);
    close();
  }, [setFollowAppLock, close]);

  const handleSelectThisApp = useCallback(() => {
    if (thisAppDisabled || !activeApp) return;
    setFollowAppLock(activeApp);
    close();
  }, [thisAppDisabled, activeApp, setFollowAppLock, close]);

  return (
    <>
      <Tooltip
        content={
          isAllApps
            ? t("simulator.replay.trajectoryAgent")
            : t("simulator.replay.trajectoryThisApp")
        }
        position="top"
        mouseEnterDelay={200}
      >
        <button
          ref={triggerRef as React.Ref<HTMLButtonElement>}
          type="button"
          onClick={toggle}
          aria-expanded={isOpen}
          aria-haspopup="listbox"
          className={`flex h-5 w-5 shrink-0 transform-gpu items-center justify-center rounded-full ${
            isOpen
              ? "bg-fill-3 text-primary-6"
              : `text-text-2 ${SURFACE_TOKENS.hover} hover:text-primary-6`
          }`}
        >
          {React.createElement(triggerIcon, { size: 14, strokeWidth: 2 })}
        </button>
      </Tooltip>
      {isOpen &&
        isPositioned &&
        createPortal(
          <div
            ref={panelRef as React.Ref<HTMLDivElement>}
            className={`${DROPDOWN_CLASSES.menuPanel} fixed overflow-y-auto`}
            style={panelPositionStyle}
          >
            <div
              className={`flex flex-col ${DROPDOWN_PANEL.itemsGapClass}`}
              role="listbox"
            >
              <button
                type="button"
                role="option"
                aria-selected={isAllApps}
                onClick={handleSelectAgent}
                className={`${DROPDOWN_CLASSES.item} ${
                  isAllApps
                    ? DROPDOWN_CLASSES.itemSelected
                    : DROPDOWN_CLASSES.itemHover
                } w-full justify-between gap-2`}
              >
                <InfinityIcon size={DROPDOWN_ITEM.iconSize} strokeWidth={2} />
                <span className="flex-1 text-left">
                  {t("simulator.replay.trajectoryAgent")}
                </span>
                {isAllApps && <DropdownSelectedCheck />}
              </button>
              <button
                type="button"
                role="option"
                aria-selected={!isAllApps}
                disabled={thisAppDisabled}
                onClick={handleSelectThisApp}
                className={`${DROPDOWN_CLASSES.item} ${
                  !isAllApps
                    ? DROPDOWN_CLASSES.itemSelected
                    : DROPDOWN_CLASSES.itemHover
                } w-full justify-between gap-2 disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {React.createElement(getActiveAppIcon(activeApp) ?? Layers, {
                  size: 12,
                  strokeWidth: 2,
                })}
                <span className="flex-1 text-left">
                  {t("simulator.replay.trajectoryThisApp")}
                </span>
                {!isAllApps && <DropdownSelectedCheck />}
              </button>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
