export {
  AGENT_ORGS_TABS,
  buildAgentOrgsPath,
  parseAgentOrgsPath,
} from "./mainAppPaths/agentOrgs";
export type {
  AgentOrgsPathOptions,
  AgentOrgsTabSegment,
} from "./mainAppPaths/agentOrgs";

export {
  buildExternalSkillsetsPath,
  DEFAULT_EXTERNAL_SKILLSETS_TAB,
  EXTERNAL_SKILLSETS_TAB_PARAM,
  EXTERNAL_SKILLSETS_TABS,
  EXTERNAL_SKILLSETS_URL_SEGMENT,
  extensionKindForSkillsetTab,
  isExternalSkillsetsTab,
  parseExternalSkillsetsTab,
} from "./mainAppPaths/externalSkillsets";
export type { ExternalSkillsetsTab } from "./mainAppPaths/externalSkillsets";

export {
  buildCodexReauthPath,
  buildIntegrationsPath,
  CODEX_REAUTH_RETURN_TO_STATE_KEY,
  filterDevModeIntegrationItems,
  getDevOnlyIntegrationRedirect,
  INTEGRATIONS_CATEGORIES,
  isIntegrationCategoryAvailable,
  parseCodexReauthIntent,
  parseIntegrationsPath,
} from "./mainAppPaths/integrations";
export type {
  IntegrationsCategorySegment,
  IntegrationsPathOptions,
} from "./mainAppPaths/integrations";

export {
  buildCoreSettingsItemPath,
  buildSettingsPath,
  buildSettingsTabPath,
  getDefaultSettingsSectionTab,
  parseCoreSettingsItem,
  parseSettingsPath,
  parseSettingsSectionTab,
  parseSettingsTopTab,
  SETTINGS_SECTION_TABS,
  SETTINGS_SECTIONS,
  SETTINGS_SUBPAGES,
  SETTINGS_TOP_TABS,
} from "./mainAppPaths/settings";
export type {
  CoreSettingsItemSegment,
  SettingsPathOptions,
  SettingsSectionSegment,
  SettingsSectionTab,
  SettingsSectionWithTabs,
  SettingsSubpageSegment,
  SettingsTopTabSegment,
} from "./mainAppPaths/settings";

export {
  classifySettingsRouteRoot,
  SETTINGS_ROUTE_ROOT,
} from "./mainAppPaths/settingsRouteRoot";
export type { SettingsRouteRoot } from "./mainAppPaths/settingsRouteRoot";

export {
  buildWizardPath,
  parseWizardParam,
  stripWizardParams,
  WIZARD_IDS,
} from "./mainAppPaths/wizards";
export type { WizardId } from "./mainAppPaths/wizards";

export {
  SEGMENT_REGISTRY,
  buildBreadcrumbLabels,
  buildBreadcrumbString,
  deriveBreadcrumbKeys,
  getPathIcon,
  getSegmentIcon,
  getSegmentLabelKey,
} from "./segmentRegistry";
export type { SegmentRegistryEntry } from "./segmentRegistry";
