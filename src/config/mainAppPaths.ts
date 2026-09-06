export {
  buildAgentOrgsPath,
  parseAgentOrgsPath,
} from "./mainAppPaths/agentOrgs";
export type { AgentOrgsTabSegment } from "./mainAppPaths/agentOrgs";

export {
  buildExternalSkillsetsPath,
  extensionKindForSkillsetTab,
  parseExternalSkillsetsTab,
} from "./mainAppPaths/externalSkillsets";
export type { ExternalSkillsetsTab } from "./mainAppPaths/externalSkillsets";

export {
  buildCodexReauthPath,
  buildIntegrationsPath,
  CODEX_REAUTH_RETURN_TO_STATE_KEY,
  filterDevModeIntegrationItems,
  getDevOnlyIntegrationRedirect,
  isIntegrationCategoryAvailable,
  parseCodexReauthIntent,
  parseIntegrationsPath,
} from "./mainAppPaths/integrations";
export type { IntegrationsCategorySegment } from "./mainAppPaths/integrations";

export {
  buildCoreSettingsItemPath,
  buildSettingsPath,
  getDefaultSettingsSectionTab,
  parseCoreSettingsItem,
  parseSettingsPath,
  parseSettingsSectionTab,
  parseSettingsTopTab,
  SETTINGS_SECTION_TABS,
  SETTINGS_SECTIONS,
} from "./mainAppPaths/settings";
export type {
  CoreSettingsItemSegment,
  SettingsPathOptions,
  SettingsSectionSegment,
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
  deriveBreadcrumbKeys,
  getPathIcon,
  getSegmentIcon,
  getSegmentLabelKey,
} from "./segmentRegistry";
