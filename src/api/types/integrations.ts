/**
 * Integrations domain types shared outside the Integrations module.
 *
 * Lives here so shared layers can import these without reaching into a
 * module-internal path.
 */

export const CATEGORY_KEYS = [
  "models",
  "myRoles",
  "housekeeper",
  "connections",
  "git",
  "tools",
  "computerUse",
  "externalSkillsets",
  "rulesMemoryEvolution",
  "routines",
  "databases",
  "devtools",
] as const;

export type IntegrationCategory = (typeof CATEGORY_KEYS)[number];

export type DetailMode = "preview" | "full";

export type AddAction =
  | "add-model"
  | "add-connection"
  | "add-git-connection"
  | "add-database"
  | "add-mcp"
  | "create-skill"
  | "import-skill"
  | "add-rule"
  | "add-routine";

/** Identifies a wizard/mode inside useExtensionsState so clearExtensionState can skip it. */
export type WizardKind = "mcp" | "skill" | "rule" | "routine";
