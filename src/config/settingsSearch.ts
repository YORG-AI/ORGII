import type {
  SettingsNavigationGroup,
  SettingsNavigationItem,
  SettingsNavigationItemId,
} from "@src/config/settingsNavigation";
import {
  SETTINGS_REGISTRY,
  type SettingDefinition,
  type SettingsCategory,
  type SettingsKey,
  getSettingsKeys,
} from "@src/config/settingsSchema";

export interface GlobalSettingsSearchItem {
  readonly id: string;
  readonly key: SettingsKey;
  readonly label: string;
  readonly path: string;
  readonly navigationItem: SettingsNavigationItem;
  readonly searchTerms: readonly string[];
}

export interface GlobalSettingsSearchGroup {
  readonly id: string;
  readonly label: string;
  readonly items: readonly GlobalSettingsSearchItem[];
}

interface SettingsSearchOwner {
  readonly navigationItemId: SettingsNavigationItemId;
  readonly tab?: string;
}

interface SettingsSearchUiOverride {
  readonly labelKey?: string;
  readonly aliasLabelKeys?: readonly string[];
  readonly owner?: SettingsSearchOwner;
}

const APPEARANCE_APP_KEYS = new Set<SettingsKey>([
  "general.theme",
  "general.linkSkinVariants",
  "general.lightSkin",
  "general.darkSkin",
  "general.primaryColorLight",
  "general.primaryColorDark",
  "general.translucentSidebar",
  "general.iconStyle",
  "general.uiScale",
  "general.usePointerCursors",
  "general.applicationUiFont",
  "general.spotlightPlacement",
  "layout.sidebarSelectedRowOpacity",
  "layout.sidebarEdgeDepthEnabled",
]);

const MY_ROLE_KEYS = new Set<SettingsKey>([
  "general.presenceGuidanceOnline",
  "general.presenceGuidanceInvisible",
  "general.presenceGuidanceAway",
  "general.profileTechSavvy",
  "general.profileJobRoles",
  "general.profileFamiliarTechStacks",
  "general.profileDescription",
  "general.activeProfileId",
  "general.profilePresets",
]);

const SECURITY_KEYS = new Set<SettingsKey>([
  "general.secretScanEnabled",
  "general.secretScanEntropyEnabled",
  "general.secretScanCustomPatterns",
]);

/**
 * Exceptions where the persisted setting key and the visible localized row
 * label intentionally use different names. All other entries are derived from
 * the schema key automatically, so new schema-backed options join search
 * without a second sidebar list.
 */
const SETTINGS_SEARCH_UI_OVERRIDES: Partial<
  Record<SettingsKey, SettingsSearchUiOverride>
> = {
  "general.theme": { labelKey: "settings:general.appearanceMode" },
  "general.primaryColorLight": {
    labelKey: "settings:general.lightAccent",
    aliasLabelKeys: ["settings:general.accent"],
  },
  "general.primaryColorDark": {
    labelKey: "settings:general.darkAccent",
    aliasLabelKeys: ["settings:general.accent"],
  },
  "general.applicationUiFont": {
    labelKey: "settings:general.applicationFont",
  },
  "general.preventSleepWhileRunning": {
    labelKey: "settings:general.preventSleep",
  },
  "general.updateChannel": { labelKey: "settings:update.channel" },
  "general.voiceInputEnabled": { labelKey: "settings:general.voiceInput" },
  "layout.sidebarSelectedRowOpacity": {
    labelKey: "settings:general.selectedItemTransparency",
  },
  "layout.sidebarEdgeDepthEnabled": {
    labelKey: "settings:general.sidebarEdgeDepth",
  },
  "general.lightSkin": {
    aliasLabelKeys: ["settings:general.skin", "settings:general.skins"],
  },
  "general.darkSkin": {
    aliasLabelKeys: ["settings:general.skin", "settings:general.skins"],
  },
  "chat.fontSize": { labelKey: "settings:agentSessions.chatFontSize" },
  "chat.codeFontSize": {
    labelKey: "settings:agentSessions.codeFontSize",
  },
  "chat.lineHeight": { labelKey: "settings:agentSessions.lineHeight" },
  "chat.typingEffectEnabled": {
    labelKey: "settings:agentSessions.typingAnimation",
  },
  "chat.typingSpeed": { labelKey: "settings:agentSessions.typingSpeed" },
  "chat.decryptEffectEnabled": {
    labelKey: "settings:agentSessions.decryptEffect",
  },
  "chat.sendOnEnter": { labelKey: "settings:agentSessions.sendOnEnter" },
  "editor.customFontFamily": {
    labelKey: "settings:editor.customFontName",
  },
  "editor.showMinimap": { labelKey: "settings:editor.minimap" },
  "editor.showTreeIndentGuides": {
    labelKey: "settings:editor.treeIndentGuides",
  },
  "terminal.fontSize": {
    labelKey: "settings:editor.terminalFontSize",
    owner: { navigationItemId: "appearance", tab: "code-editor" },
  },
  "terminal.shellType": { labelKey: "settings:editor.shellsOpenWith" },
  "terminal.customShellPath": {
    labelKey: "settings:editor.customCommand",
  },
  "workspace.defaultRepoLocation": {
    labelKey: "settings:editor.defaultRepoFolder",
  },
  "workspace.customDefaultRepoPath": {
    labelKey: "settings:editor.customDefaultRepoFolder",
  },
  "notifications.enabled": { labelKey: "settings:notifications.enable" },
  "notifications.completionSound": {
    labelKey: "settings:notifications.enableSound",
  },
  "notifications.systemNotificationEnabled": {
    labelKey: "settings:notifications.enableSystem",
  },
  "notifications.dockBadgeEnabled": {
    labelKey: "settings:notifications.enableDockBadge",
  },
  "notifications.soundVolume": {
    labelKey: "settings:notifications.volume",
  },
  "general.language": { labelKey: "common:common.language" },
  "general.timezone": { labelKey: "common:common.timezone" },
  "general.secretScanEnabled": { labelKey: "settings:security.scan" },
  "general.secretScanEntropyEnabled": {
    labelKey: "settings:security.entropy",
  },
  "general.secretScanCustomPatterns": {
    labelKey: "settings:security.customPatterns",
  },
  "general.profileTechSavvy": {
    labelKey: "settings:myRoles.profile.techSavvy",
  },
  "general.profileJobRoles": {
    labelKey: "settings:myRoles.profile.jobRoles",
  },
  "general.profileFamiliarTechStacks": {
    labelKey: "settings:myRoles.profile.familiarTechStacks",
  },
  "general.profileDescription": {
    labelKey: "settings:myRoles.profile.description",
  },
  "general.activeProfileId": {
    labelKey: "settings:myRoles.profile.activeProfile",
  },
  "general.profilePresets": {
    labelKey: "settings:myRoles.profile.profileName",
  },
  "network.httpVersion": { labelKey: "settings:monitor.httpVersion" },
  "notifications.quietHours.enabled": {
    labelKey: "settings:notifications.quietHours",
  },
  "notifications.quietHours.start": {
    labelKey: "settings:notifications.quietHoursStart",
    aliasLabelKeys: ["settings:notifications.quietHoursSchedule"],
  },
  "notifications.quietHours.end": {
    labelKey: "settings:notifications.quietHoursEnd",
    aliasLabelKeys: ["settings:notifications.quietHoursSchedule"],
  },
  "notifications.quietHours.allowCritical": {
    labelKey: "settings:notifications.allowCriticalDuringQuietHours",
  },
  "notifications.categories.taskCompletion": {
    labelKey: "settings:notifications.taskCompletion",
  },
  "notifications.categories.agentApproval": {
    labelKey: "settings:notifications.agentApproval",
  },
  "notifications.categories.errors": {
    labelKey: "settings:notifications.errors",
  },
  "notifications.categories.teamInbox": {
    labelKey: "settings:notifications.teamInbox",
  },
};

const CATEGORY_OWNER: Record<SettingsCategory, SettingsSearchOwner> = {
  general: { navigationItemId: "general", tab: "general" },
  editor: { navigationItemId: "appearance", tab: "code-editor" },
  terminal: { navigationItemId: "editor", tab: "editor" },
  notifications: { navigationItemId: "general", tab: "notifications" },
  chat: { navigationItemId: "appearance", tab: "chat-panel" },
  workspace: { navigationItemId: "editor", tab: "editor" },
  git: { navigationItemId: "git" },
  agent: { navigationItemId: "agent-orgs" },
  agentBrowser: { navigationItemId: "computerUse" },
  housekeeper: { navigationItemId: "housekeeper" },
  network: { navigationItemId: "monitor", tab: "network" },
  privacy: { navigationItemId: "general", tab: "general" },
  mobileRemote: { navigationItemId: "connections" },
};

function resolveOwner(
  key: SettingsKey,
  category: SettingsCategory
): SettingsSearchOwner {
  const override = SETTINGS_SEARCH_UI_OVERRIDES[key]?.owner;
  if (override) return override;
  if (APPEARANCE_APP_KEYS.has(key)) {
    return { navigationItemId: "appearance", tab: "app" };
  }
  if (
    key.startsWith("background.") ||
    key.startsWith("sidebar.") ||
    key.startsWith("layout.")
  ) {
    return { navigationItemId: "appearance", tab: "app" };
  }
  if (key.startsWith("general.chat") || key === "general.modelPickerStyle") {
    return { navigationItemId: "appearance", tab: "chat-panel" };
  }
  if (MY_ROLE_KEYS.has(key)) return { navigationItemId: "myRoles" };
  if (SECURITY_KEYS.has(key)) return { navigationItemId: "security" };
  return CATEGORY_OWNER[category];
}

function humanizeSettingKey(key: SettingsKey): string {
  const leaf = key.slice(key.lastIndexOf(".") + 1);
  return leaf
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (character) => character.toLocaleUpperCase());
}

function translateWithFallback(
  translate: (key: string) => string,
  translationKey: string,
  fallback: string
): string {
  const translated = translate(translationKey);
  return translated && translated !== translationKey ? translated : fallback;
}

function buildItemPath(
  navigationItem: SettingsNavigationItem,
  tab: string | undefined
): string {
  return tab ? `${navigationItem.path}/${tab}` : navigationItem.path;
}

/**
 * Build the global, localized index from the settings schema on demand.
 *
 * The result contains no mounted React pages and installs no observers. It is
 * recomputed only when navigation visibility or the active locale changes.
 */
export function buildGlobalSettingsSearchGroups(
  translate: (key: string) => string,
  navigationGroups: readonly SettingsNavigationGroup[]
): GlobalSettingsSearchGroup[] {
  const navigationItems = navigationGroups.flatMap((group) => group.items);
  const itemById = new Map(
    navigationItems.map((item) => [item.id, item] as const)
  );
  const itemsByOwner = new Map<
    SettingsNavigationItemId,
    GlobalSettingsSearchItem[]
  >();

  for (const key of getSettingsKeys()) {
    const definition: SettingDefinition = SETTINGS_REGISTRY[key];
    const metadata = SETTINGS_SEARCH_UI_OVERRIDES[key];
    const owner = resolveOwner(key, definition.category);
    const navigationItem = itemById.get(owner.navigationItemId);
    if (!navigationItem) continue;

    const fallbackLabel = humanizeSettingKey(key);
    const labelKey = metadata?.labelKey ?? `settings:${key}`;
    const label = translateWithFallback(translate, labelKey, fallbackLabel);
    const aliasLabels = (metadata?.aliasLabelKeys ?? []).map((aliasKey) =>
      translateWithFallback(translate, aliasKey, "")
    );
    const enumLabels = Object.values(definition.enumLabels ?? {});
    const item: GlobalSettingsSearchItem = {
      id: `setting-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
      key,
      label,
      path: buildItemPath(navigationItem, owner.tab),
      navigationItem,
      searchTerms: [
        key,
        definition.description,
        ...aliasLabels,
        ...enumLabels,
      ].filter(Boolean),
    };
    const ownerItems = itemsByOwner.get(owner.navigationItemId) ?? [];
    ownerItems.push(item);
    itemsByOwner.set(owner.navigationItemId, ownerItems);
  }

  return navigationItems.flatMap((navigationItem) => {
    const items = itemsByOwner.get(navigationItem.id) ?? [];
    return items.length > 0
      ? [
          {
            id: `settings-controls-${navigationItem.id}`,
            label: navigationItem.label,
            items,
          },
        ]
      : [];
  });
}
