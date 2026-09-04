/**
 * SettingsBreadcrumb
 *
 * Canonical header label for the Settings workspace-header (the global
 * top bar that hosts the Tauri drag region and the maximize toggle).
 * Renders `Settings › <currentLabel> [› <wizardTitle>]` where:
 *
 *   - "Settings" is a static crumb (no navigation).
 *   - `currentLabel` is the active section / category (Models & Keys,
 *     Routines, General, Agents, ...) derived from the URL via
 *     `SEGMENT_REGISTRY`.
 *   - The trailing crumb is either the active wizard's title
 *     (`wizardBreadcrumbTitleAtom` — wizards no longer render their own
 *     40px header bar) OR the active in-page selection title
 *     (`settingsSelectionTitleAtom` — e.g. the selected agent/team name
 *     on the Agent Teams page). Wizard wins when both are set, which
 *     matches the way pages clear their selection on wizard open.
 *
 * The selector consumes the same settings-navigation projection as the
 * sidebar, so adding or moving an option never requires per-surface wiring.
 */
import { useAtomValue } from "jotai";
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import { DROPDOWN_ITEM } from "@src/components/Dropdown/tokens";
import {
  SETTINGS_ROUTE_ROOT,
  classifySettingsRouteRoot,
  deriveBreadcrumbKeys,
  getSegmentLabelKey,
} from "@src/config/mainAppPaths";
import {
  type SettingsNavigationItem,
  buildSettingsNavigationGroups,
  getActiveSettingsNavigationItemId,
} from "@src/config/settingsNavigation";
import { ArrowRight01Icon, HugeiconsIcon } from "@src/icons";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";
import {
  settingsSelectionTitleAtom,
  wizardBreadcrumbTitleAtom,
} from "@src/store/ui/wizardBreadcrumbAtom";

import { BreadcrumbPillNavTrigger } from "../BreadcrumbPillNav";
import SettingsSearchDropdown from "../SettingsSearchDropdown";

interface SettingsBreadcrumbProps {
  /** Optional className passthrough. */
  className?: string;
}

const SETTINGS_LABEL_KEY = "navigation:labels.settings";
const Separator: React.FC = () => (
  <HugeiconsIcon
    icon={ArrowRight01Icon}
    data-icon="chevron-right"
    size={DROPDOWN_ITEM.iconSize}
    strokeWidth={1.75}
    className="shrink-0 text-fill-4"
  />
);

const SettingsBreadcrumb: React.FC<SettingsBreadcrumbProps> = ({
  className = "",
}) => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const wizardTitle = useAtomValue(wizardBreadcrumbTitleAtom);
  const selectionTitle = useAtomValue(settingsSelectionTitleAtom);
  const devModeEnabled = useAtomValue(devModeEnabledAtom);
  const leafTitle = wizardTitle ?? selectionTitle;
  const selectorGroups = useMemo(
    () => buildSettingsNavigationGroups(t, devModeEnabled),
    [devModeEnabled, t]
  );

  const flatItems = useMemo(
    () => selectorGroups.flatMap((group) => group.items),
    [selectorGroups]
  );

  const activeItemId = useMemo(
    () => getActiveSettingsNavigationItemId(location.pathname),
    [location.pathname]
  );
  const activeItem = useMemo(
    () => flatItems.find((item) => item.id === activeItemId) ?? null,
    [activeItemId, flatItems]
  );

  const { settingsLabel, sectionLabel } = useMemo(() => {
    const keys = deriveBreadcrumbKeys(location.pathname);
    const root = t(SETTINGS_LABEL_KEY, { defaultValue: "Settings" });
    const tail = keys.filter((key) => key !== SETTINGS_LABEL_KEY);
    const routeRoot = classifySettingsRouteRoot(location.pathname);
    const fallbackSection = selectorGroups[0]?.items[0]?.id;
    const fallbackLabelKey =
      routeRoot === SETTINGS_ROUTE_ROOT.APP &&
      tail.length === 0 &&
      fallbackSection
        ? getSegmentLabelKey(fallbackSection)
        : null;
    const leafLabelKey = tail[tail.length - 1] ?? fallbackLabelKey;
    const leaf = leafLabelKey ? t(leafLabelKey) : "";
    return { settingsLabel: root, sectionLabel: leaf };
  }, [location.pathname, selectorGroups, t]);

  const selectorLabel = activeItem?.label ?? sectionLabel;
  const handleSelect = useCallback(
    (item: SettingsNavigationItem) => navigate(item.path),
    [navigate]
  );

  return (
    <>
      <span
        className={`flex h-7 max-w-full min-w-0 cursor-default items-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium text-text-1 ${className}`}
      >
        <span className="shrink-0 text-text-2">{settingsLabel}</span>
        {sectionLabel && (
          <>
            <Separator />
            <SettingsSearchDropdown
              groups={selectorGroups}
              activeItemId={activeItemId}
              onSelect={handleSelect}
              renderTrigger={({ isOpen, listboxId, onClick }) => (
                <BreadcrumbPillNavTrigger
                  isOpen={isOpen}
                  variant={leafTitle ? "secondary" : "primary"}
                  onClick={onClick}
                  aria-haspopup="listbox"
                  aria-expanded={isOpen}
                  aria-controls={listboxId}
                  className="min-w-0"
                >
                  <span className="min-w-0 truncate">{selectorLabel}</span>
                </BreadcrumbPillNavTrigger>
              )}
            />
          </>
        )}
        {leafTitle && (
          <>
            <Separator />
            <span className="min-w-0 truncate">{leafTitle}</span>
          </>
        )}
      </span>
    </>
  );
};

export default SettingsBreadcrumb;
