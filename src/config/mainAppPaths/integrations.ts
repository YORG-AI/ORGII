import { SETTINGS_BASE, settingsPathParts } from "./shared";

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
  | "sessionMemoryEmbedding"
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
  "sessionMemoryEmbedding",
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
export const SESSION_MEMORY_EMBEDDING_URL_SEGMENT = "session-memory-embedding";

/** Map an internal category key to the URL slug used in pathnames. */
export function toCategoryUrlSegment(
  category: IntegrationsCategorySegment
): string {
  if (category === "rulesMemoryEvolution") {
    return RULES_MEMORY_EVOLUTION_URL_SEGMENT;
  }
  if (category === "sessionMemoryEmbedding") {
    return SESSION_MEMORY_EMBEDDING_URL_SEGMENT;
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
  if (segment === SESSION_MEMORY_EMBEDDING_URL_SEGMENT) {
    return "sessionMemoryEmbedding";
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

export function buildIntegrationsPath(
  options: IntegrationsPathOptions = {}
): string {
  const category = options.category ?? "models";
  return `${SETTINGS_BASE}/integrations/${toCategoryUrlSegment(category)}`;
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
