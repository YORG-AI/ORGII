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
 * Adding a new settings section only requires registering its URL slug
 * in `SEGMENT_REGISTRY` — no per-page wiring.
 */
import { useAtomValue } from "jotai";
import { Check, ChevronRight, type LucideIcon, Search } from "lucide-react";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";

import {
  DROPDOWN_CLASSES,
  DROPDOWN_ITEM,
  DROPDOWN_PANEL,
  DROPDOWN_SEARCH,
  DROPDOWN_WIDTHS,
} from "@src/components/Dropdown/tokens";
import {
  SETTINGS_ROUTE_ROOT,
  SETTINGS_SECTIONS,
  buildAgentOrgsPath,
  buildCoreSettingsItemPath,
  classifySettingsRouteRoot,
  deriveBreadcrumbKeys,
  filterDevModeIntegrationItems,
  getSegmentIcon,
  getSegmentLabelKey,
  parseCoreSettingsItem,
  parseSettingsTopTab,
} from "@src/config/mainAppPaths";
import type { CoreSettingsItemSegment } from "@src/config/mainAppPaths";
import { useDropdownEngine } from "@src/hooks/dropdown";
import { useTauriSelectAllShortcut } from "@src/hooks/keyboard";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";
import {
  settingsSelectionTitleAtom,
  wizardBreadcrumbTitleAtom,
} from "@src/store/ui/wizardBreadcrumbAtom";

import { BreadcrumbPillNavTrigger } from "../BreadcrumbPillNav";

export interface SettingsBreadcrumbProps {
  /** Optional className passthrough. */
  className?: string;
}

const SETTINGS_LABEL_KEY = "navigation:labels.settings";
const AGENT_ORG_ROW_KEY = "agent-orgs";
interface SettingsSelectorGroupConfig {
  readonly id: string;
  readonly labelKey: string | null;
  readonly itemIds: readonly SettingsSelectorItemId[];
}

type SettingsSelectorItemId =
  | CoreSettingsItemSegment
  | typeof AGENT_ORG_ROW_KEY;

interface SettingsSelectorItem {
  readonly id: SettingsSelectorItemId;
  readonly label: string;
  readonly path: string;
  readonly icon: LucideIcon | null;
  readonly groupId: string;
}

interface SettingsSelectorGroup {
  readonly id: string;
  readonly label: string | null;
  readonly items: readonly SettingsSelectorItem[];
}

const SETTINGS_SELECTOR_GROUPS: readonly SettingsSelectorGroupConfig[] = [
  {
    id: "app",
    labelKey: null,
    itemIds: SETTINGS_SECTIONS,
  },
  {
    id: "core",
    labelKey: "settings:coreSidebar.groups.core",
    itemIds: [
      AGENT_ORG_ROW_KEY,
      "models",
      "myRoles",
      "housekeeper",
      "rulesMemoryEvolution",
      "routines",
    ],
  },
  {
    id: "tools",
    labelKey: "settings:coreSidebar.groups.tools",
    itemIds: ["tools", "computerUse", "externalSkillsets", "devtools"],
  },
  {
    id: "connections",
    labelKey: "settings:coreSidebar.groups.connections",
    itemIds: ["connections", "databases"],
  },
];

function getSettingsSelectorItemPath(id: SettingsSelectorItemId): string {
  if (id === AGENT_ORG_ROW_KEY) {
    return buildAgentOrgsPath({ tab: "agents" });
  }
  return buildCoreSettingsItemPath(id);
}

function isSettingsSelectorItemActive(
  item: SettingsSelectorItem,
  pathname: string
): boolean {
  if (item.id === AGENT_ORG_ROW_KEY) {
    const topTab = parseSettingsTopTab(pathname);
    return topTab === "agent-orgs";
  }

  const { section, category } = parseCoreSettingsItem(pathname);
  return item.id === section || item.id === category;
}

const Separator: React.FC = () => (
  <ChevronRight
    size={DROPDOWN_ITEM.iconSize}
    strokeWidth={1.75}
    className="flex-shrink-0 text-fill-4"
  />
);

const SettingsBreadcrumb: React.FC<SettingsBreadcrumbProps> = ({
  className = "",
}) => {
  const { t } = useTranslation();
  const { t: tCommon } = useTranslation("common");
  const { t: tSettings } = useTranslation("settings");
  const location = useLocation();
  const navigate = useNavigate();
  const wizardTitle = useAtomValue(wizardBreadcrumbTitleAtom);
  const selectionTitle = useAtomValue(settingsSelectionTitleAtom);
  const devModeEnabled = useAtomValue(devModeEnabledAtom);
  const leafTitle = wizardTitle ?? selectionTitle;
  const [searchQuery, setSearchQuery] = useState("");
  const [selectorOpen, setSelectorOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const tauriSelectAll = useTauriSelectAllShortcut();

  const selectorGroups = useMemo<SettingsSelectorGroup[]>(
    () =>
      SETTINGS_SELECTOR_GROUPS.map((group) => ({
        id: group.id,
        label: group.labelKey ? t(group.labelKey) : null,
        items: filterDevModeIntegrationItems(group.itemIds, devModeEnabled).map(
          (id) => {
            const labelKey =
              id === AGENT_ORG_ROW_KEY ? null : getSegmentLabelKey(id);
            return {
              id,
              label: labelKey ? t(labelKey) : t("navigation:labels.agentOrgs"),
              path: getSettingsSelectorItemPath(id),
              icon:
                id === AGENT_ORG_ROW_KEY
                  ? getSegmentIcon("agents")
                  : getSegmentIcon(id),
              groupId: group.id,
            };
          }
        ),
      })),
    [devModeEnabled, t]
  );

  const flatItems = useMemo(
    () => selectorGroups.flatMap((group) => group.items),
    [selectorGroups]
  );

  const activeItem = useMemo(
    () =>
      flatItems.find((item) =>
        isSettingsSelectorItemActive(item, location.pathname)
      ) ??
      flatItems[0] ??
      null,
    [flatItems, location.pathname]
  );

  const filteredGroups = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return selectorGroups;
    return selectorGroups
      .map((group) => ({
        ...group,
        items: group.items.filter((item) =>
          item.label.toLowerCase().includes(query)
        ),
      }))
      .filter((group) => group.items.length > 0);
  }, [searchQuery, selectorGroups]);

  const visibleItems = useMemo(
    () => filteredGroups.flatMap((group) => group.items),
    [filteredGroups]
  );

  const {
    isOpen,
    isPositioned,
    toggle,
    triggerRef,
    panelRef,
    panelPosition,
    keyboard,
  } = useDropdownEngine<HTMLButtonElement, SettingsSelectorItem>({
    open: selectorOpen,
    onOpenChange: (open) => {
      setSelectorOpen(open);
      if (open) setSearchQuery("");
    },
    gap: DROPDOWN_PANEL.triggerGapTight,
    placement: "bottom",
    align: "left",
    listNavigation: {
      disableGlobalListener: true,
      items: visibleItems,
      onSelect: (item) => {
        navigate(item.path);
        setSelectorOpen(false);
      },
    },
  });

  useEffect(() => {
    if (!isOpen) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isOpen]);

  const { settingsLabel, sectionLabel } = useMemo(() => {
    const keys = deriveBreadcrumbKeys(location.pathname);
    const root = t(SETTINGS_LABEL_KEY, { defaultValue: "Settings" });
    const tail = keys.filter((key) => key !== SETTINGS_LABEL_KEY);
    const routeRoot = classifySettingsRouteRoot(location.pathname);
    const fallbackSection = SETTINGS_SECTIONS[0];
    const fallbackLabelKey =
      routeRoot === SETTINGS_ROUTE_ROOT.APP && tail.length === 0
        ? getSegmentLabelKey(fallbackSection)
        : null;
    const leafLabelKey = tail[tail.length - 1] ?? fallbackLabelKey;
    const leaf = leafLabelKey ? t(leafLabelKey) : "";
    return { settingsLabel: root, sectionLabel: leaf };
  }, [location.pathname, t]);

  const selectorLabel = activeItem?.label ?? sectionLabel;
  const dropdown =
    isOpen && isPositioned
      ? createPortal(
          <div
            ref={panelRef}
            className={`${DROPDOWN_CLASSES.panel} ${DROPDOWN_WIDTHS.panelWidthClass} fixed flex flex-col`}
            onKeyDown={keyboard.handleKeyDown}
            style={{
              top: panelPosition.top,
              bottom: panelPosition.bottom,
              left: panelPosition.left,
              right: panelPosition.right,
              minWidth: Math.max(panelPosition.width, 240),
            }}
          >
            <div className={DROPDOWN_CLASSES.searchContainer}>
              <Search
                size={DROPDOWN_SEARCH.iconSize}
                className="shrink-0 text-text-3"
              />
              <input
                ref={inputRef}
                type="text"
                value={searchQuery}
                onChange={(event) => {
                  setSearchQuery(event.target.value);
                  keyboard.setSelectedIndex(0);
                }}
                onKeyDown={(event) => {
                  tauriSelectAll(event);
                  if (event.defaultPrevented) return;
                  if (
                    event.key === "ArrowDown" ||
                    event.key === "ArrowUp" ||
                    event.key === "Enter"
                  ) {
                    keyboard.handleKeyDown(event);
                  }
                }}
                placeholder={tSettings("searchPlaceholder")}
                className={DROPDOWN_CLASSES.searchInput}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
              />
            </div>
            <div
              className={`${DROPDOWN_CLASSES.optionsContainerOverlay} max-h-[360px]`}
            >
              {filteredGroups.length === 0 ? (
                <div className={DROPDOWN_CLASSES.listMessage}>
                  {tCommon("status.noResults")}
                </div>
              ) : (
                filteredGroups.map((group) => (
                  <React.Fragment key={group.id}>
                    {group.label && (
                      <div className={DROPDOWN_CLASSES.sectionLabel}>
                        {group.label}
                      </div>
                    )}
                    {group.items.map((item) => {
                      const itemIndex = visibleItems.findIndex(
                        (visibleItem) => visibleItem.id === item.id
                      );
                      const isActive = item.id === activeItem?.id;
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.id}
                          type="button"
                          {...keyboard.getItemProps(itemIndex)}
                          data-settings-breadcrumb-row="true"
                          className={`${DROPDOWN_CLASSES.item} w-full justify-start text-left ${
                            isActive
                              ? DROPDOWN_CLASSES.itemSelected
                              : DROPDOWN_CLASSES.itemHover
                          }`}
                        >
                          {Icon && (
                            <Icon
                              size={DROPDOWN_ITEM.iconSize}
                              className={`shrink-0 ${
                                isActive ? "text-primary-6" : "text-text-2"
                              }`}
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate">
                            {item.label}
                          </span>
                          {isActive && (
                            <Check
                              size={DROPDOWN_ITEM.iconSize}
                              className="shrink-0 text-primary-6"
                            />
                          )}
                        </button>
                      );
                    })}
                  </React.Fragment>
                ))
              )}
            </div>
          </div>,
          document.body
        )
      : null;

  return (
    <>
      <span
        className={`flex h-7 min-w-0 max-w-full cursor-default items-center gap-1.5 rounded-lg px-1.5 text-[13px] font-medium text-text-1 ${className}`}
      >
        <span className="flex-shrink-0 text-text-2">{settingsLabel}</span>
        {sectionLabel && (
          <>
            <Separator />
            <BreadcrumbPillNavTrigger
              ref={triggerRef}
              isOpen={isOpen}
              variant={leafTitle ? "secondary" : "primary"}
              onClick={toggle}
              aria-haspopup="listbox"
              aria-expanded={isOpen}
              className="min-w-0"
            >
              <span className="min-w-0 truncate">{selectorLabel}</span>
            </BreadcrumbPillNavTrigger>
          </>
        )}
        {leafTitle && (
          <>
            <Separator />
            <span className="min-w-0 truncate">{leafTitle}</span>
          </>
        )}
      </span>
      {dropdown}
    </>
  );
};

export default SettingsBreadcrumb;
