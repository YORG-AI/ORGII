import "./integrations";
import { buildCoreSettingsItemPath } from "./settings";

export const EXTERNAL_SKILLSETS_TAB_PARAM = "skillsetTab";

export const EXTERNAL_SKILLSETS_TABS = [
  "skills",
  "mcp",
  "cursor-plugins",
] as const;

export type ExternalSkillsetsTab = (typeof EXTERNAL_SKILLSETS_TABS)[number];

export const DEFAULT_EXTERNAL_SKILLSETS_TAB: ExternalSkillsetsTab = "skills";

export function isExternalSkillsetsTab(
  value: string | null | undefined
): value is ExternalSkillsetsTab {
  return (
    !!value && (EXTERNAL_SKILLSETS_TABS as readonly string[]).includes(value)
  );
}

export interface ExternalSkillsetsPathOptions {
  tab?: ExternalSkillsetsTab;
}

export function buildExternalSkillsetsPath(
  options: ExternalSkillsetsPathOptions = {}
): string {
  const base = buildCoreSettingsItemPath("externalSkillsets");
  const tab = options.tab ?? DEFAULT_EXTERNAL_SKILLSETS_TAB;
  if (tab === DEFAULT_EXTERNAL_SKILLSETS_TAB) {
    return base;
  }
  const params = new URLSearchParams();
  params.set(EXTERNAL_SKILLSETS_TAB_PARAM, tab);
  return `${base}?${params.toString()}`;
}

export function parseExternalSkillsetsTab(
  search: string
): ExternalSkillsetsTab {
  const params = new URLSearchParams(search);
  const raw = params.get(EXTERNAL_SKILLSETS_TAB_PARAM);
  return isExternalSkillsetsTab(raw) ? raw : DEFAULT_EXTERNAL_SKILLSETS_TAB;
}

export function extensionKindForSkillsetTab(
  tab: ExternalSkillsetsTab
): "mcp" | "skills" | "cursor-plugins" {
  if (tab === "mcp") return "mcp";
  if (tab === "cursor-plugins") return "cursor-plugins";
  return "skills";
}
