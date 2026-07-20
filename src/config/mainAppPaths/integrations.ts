import { SETTINGS_BASE, settingsPathParts } from "./shared";
import { WIZARD_IDS, buildWizardPath } from "./wizards";

export const EXTERNAL_SKILLSETS_URL_SEGMENT = "skills-mcps-plugins";

export type IntegrationsCategorySegment =
  | "models"
  | "myRoles"
  | "housekeeper"
  | "tools"
  | "computerUse"
  | "externalSkillsets"
  | "connections"
  | "git"
  | "databases"
  | "rulesMemoryEvolution"
  | "routines"
  | "devtools";

export const INTEGRATIONS_CATEGORIES: readonly IntegrationsCategorySegment[] = [
  "models",
  "myRoles",
  "housekeeper",
  "tools",
  "computerUse",
  "externalSkillsets",
  "connections",
  "git",
  "databases",
  "rulesMemoryEvolution",
  "routines",
  "devtools",
] as const;

/**
 * Compound Integration categories use descriptive public URL slugs while
 * keeping their camel-cased internal routing keys.
 * {@link toCategoryUrlSegment} maps keys to slugs when building paths;
 * {@link fromCategoryUrlSegment} maps slugs back to keys.
 */
export const RULES_MEMORY_EVOLUTION_URL_SEGMENT = "rules-memory-and-evolution";

/** Map an internal category key to the URL slug used in pathnames. */
export function toCategoryUrlSegment(
  category: IntegrationsCategorySegment
): string {
  if (category === "rulesMemoryEvolution") {
    return RULES_MEMORY_EVOLUTION_URL_SEGMENT;
  }
  if (category === "externalSkillsets") {
    return EXTERNAL_SKILLSETS_URL_SEGMENT;
  }
  if (category === "myRoles") {
    return "my-roles";
  }
  return category;
}

/** Normalize a raw URL slug back to its internal category key. */
export function fromCategoryUrlSegment(segment: string): string {
  if (segment === RULES_MEMORY_EVOLUTION_URL_SEGMENT) {
    return "rulesMemoryEvolution";
  }
  if (segment === EXTERNAL_SKILLSETS_URL_SEGMENT) {
    return "externalSkillsets";
  }
  if (segment === "my-roles") {
    return "myRoles";
  }
  return segment;
}

export interface IntegrationsPathOptions {
  category?: IntegrationsCategorySegment;
}

const CODEX_REAUTH_PARAM = "reauth";
const CODEX_REAUTH_VALUE = "codex";
const CODEX_REAUTH_AUTO_START_PARAM = "autoStart";

export const CODEX_REAUTH_RETURN_TO_STATE_KEY = "codexReauthReturnTo";

export function buildIntegrationsPath(
  options: IntegrationsPathOptions = {}
): string {
  const category = options.category ?? "models";
  return `${SETTINGS_BASE}/integrations/${toCategoryUrlSegment(category)}`;
}

/** Build the direct KeyVault → Codex OAuth repair route. */
export function buildCodexReauthPath(accountId?: string): string {
  const wizardPath = buildWizardPath(
    `${SETTINGS_BASE}/models`,
    WIZARD_IDS.KEY_ADD,
    accountId
  );
  const [pathname, search = ""] = wizardPath.split("?");
  const params = new URLSearchParams(search);
  params.set(CODEX_REAUTH_PARAM, CODEX_REAUTH_VALUE);
  params.set(CODEX_REAUTH_AUTO_START_PARAM, "true");
  return `${pathname}?${params.toString()}`;
}

export function parseCodexReauthIntent(search: string): {
  active: boolean;
  autoStart: boolean;
} {
  const params = new URLSearchParams(search);
  const active = params.get(CODEX_REAUTH_PARAM) === CODEX_REAUTH_VALUE;
  return {
    active,
    autoStart: active && params.get(CODEX_REAUTH_AUTO_START_PARAM) === "true",
  };
}

export function parseIntegrationsPath(pathname: string): {
  category: IntegrationsCategorySegment | null;
} {
  const parts = settingsPathParts(pathname);
  const rawCategory = parts[0] === "integrations" ? parts[1] : parts[0];
  const normalizedCategory = rawCategory
    ? fromCategoryUrlSegment(rawCategory)
    : null;
  const category =
    normalizedCategory &&
    (INTEGRATIONS_CATEGORIES as readonly string[]).includes(normalizedCategory)
      ? (normalizedCategory as IntegrationsCategorySegment)
      : null;
  return { category };
}
