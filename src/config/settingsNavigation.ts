import type { RenderableIcon } from "@src/components/AnyIcon";
import {
  type CoreSettingsItemSegment,
  SETTINGS_SECTIONS,
  type SettingsSectionSegment,
  buildAgentOrgsPath,
  buildCoreSettingsItemPath,
  filterDevModeIntegrationItems,
  getSegmentIcon,
  getSegmentLabelKey,
  parseCoreSettingsItem,
  parseSettingsTopTab,
} from "@src/config/mainAppPaths";
import { getSettingsSectionsByTab } from "@src/config/settingsUiManifest";
import { Infinity01Icon } from "@src/icons";

export const AGENT_ORGS_SETTINGS_NAVIGATION_ID = "agent-orgs" as const;

export type SettingsNavigationItemId =
  | CoreSettingsItemSegment
  | typeof AGENT_ORGS_SETTINGS_NAVIGATION_ID;

export interface SettingsNavigationItem {
  readonly id: SettingsNavigationItemId;
  readonly label: string;
  readonly path: string;
  readonly icon: RenderableIcon;
  readonly groupId: string;
  readonly dataTestId: string;
}

export interface SettingsNavigationGroup {
  readonly id: string;
  readonly label: string | null;
  readonly items: readonly SettingsNavigationItem[];
}

interface SettingsNavigationGroupDefinition {
  readonly id: string;
  readonly labelKey: string | null;
  readonly itemIds: readonly SettingsNavigationItemId[];
}

const SECURITY_ITEM_ID: SettingsSectionSegment = "security";

function asSettingsSectionSegment(id: string): SettingsSectionSegment {
  if (!(SETTINGS_SECTIONS as readonly string[]).includes(id)) {
    throw new Error(
      `settingsNavigation: app section "${id}" has no settings route segment`
    );
  }
  return id as SettingsSectionSegment;
}

const APP_SECTION_ITEM_IDS = getSettingsSectionsByTab("app")
  .map((section) => asSettingsSectionSegment(section.id))
  // Security is an app section, but product navigation places it in Core.
  .filter((id) => id !== SECURITY_ITEM_ID);

/**
 * Canonical ordering and grouping for every Settings navigation surface.
 *
 * App sections are derived from the Settings UI manifest. Integration
 * destinations need only be placed in one group here; the sidebar and every
 * settings selector/search dropdown consume the resulting projection.
 */
const SETTINGS_NAVIGATION_GROUP_DEFINITIONS: readonly SettingsNavigationGroupDefinition[] =
  [
    {
      id: "app",
      labelKey: null,
      itemIds: APP_SECTION_ITEM_IDS,
    },
    {
      id: "core",
      labelKey: "settings:coreSidebar.groups.core",
      itemIds: [
        AGENT_ORGS_SETTINGS_NAVIGATION_ID,
        "models",
        "myRoles",
        "rulesMemoryEvolution",
        SECURITY_ITEM_ID,
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
      itemIds: ["connections", "git", "databases", "housekeeper"],
    },
  ];

function buildSettingsNavigationItem(
  id: SettingsNavigationItemId,
  groupId: string,
  translate: (key: string) => string
): SettingsNavigationItem {
  const registrySegment =
    id === AGENT_ORGS_SETTINGS_NAVIGATION_ID ? "agents" : id;
  const labelKey =
    id === AGENT_ORGS_SETTINGS_NAVIGATION_ID
      ? "navigation:labels.agentOrgs"
      : groupId === "app"
        ? getSegmentLabelKey(registrySegment)
        : `settings:coreSidebar.items.${id}`;
  const icon =
    id === AGENT_ORGS_SETTINGS_NAVIGATION_ID
      ? Infinity01Icon
      : getSegmentIcon(registrySegment);

  if (!labelKey || !icon) {
    throw new Error(
      `settingsNavigation: missing segment-registry entry for "${registrySegment}"`
    );
  }

  const path =
    id === AGENT_ORGS_SETTINGS_NAVIGATION_ID
      ? buildAgentOrgsPath({ tab: "agents" })
      : buildCoreSettingsItemPath(id);

  return {
    id,
    label: translate(labelKey),
    path,
    icon,
    groupId,
    dataTestId: `settings-core-item-${id}`,
  };
}

export function buildSettingsNavigationGroups(
  translate: (key: string) => string,
  devModeEnabled: boolean
): SettingsNavigationGroup[] {
  return SETTINGS_NAVIGATION_GROUP_DEFINITIONS.map((group) => ({
    id: group.id,
    label: group.labelKey ? translate(group.labelKey) : null,
    items: filterDevModeIntegrationItems(group.itemIds, devModeEnabled).map(
      (id) => buildSettingsNavigationItem(id, group.id, translate)
    ),
  }));
}

export function getActiveSettingsNavigationItemId(
  pathname: string
): SettingsNavigationItemId {
  if (parseSettingsTopTab(pathname) === "agent-orgs") {
    return AGENT_ORGS_SETTINGS_NAVIGATION_ID;
  }

  const { section, category } = parseCoreSettingsItem(pathname);
  return (
    section ??
    category ??
    APP_SECTION_ITEM_IDS[0] ??
    AGENT_ORGS_SETTINGS_NAVIGATION_ID
  );
}
