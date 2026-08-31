export const WIZARD_IDS = {
  KEY_ADD: "key-add",
  MCP_ADD: "mcp-add",
  MCP_EDIT: "mcp-edit",
  SKILL_CREATE: "skill-create",
  SKILL_EDIT: "skill-edit",
  SKILL_IMPORT: "skill-import",
  CHANNEL_ADD: "channel-add",
  DB_CONNECTION_ADD: "db-connection-add",
  ROUTINE_ADD: "routine-add",
  ROUTINE_EDIT: "routine-edit",
  RULE_ADD: "rule-add",
  RULE_EDIT: "rule-edit",
  AGENT_ADD: "agent-add",
  ORG_ADD: "org-add",
  ORG_EDIT: "org-edit",
} as const;

export type WizardId = (typeof WIZARD_IDS)[keyof typeof WIZARD_IDS];

const WIZARD_PARAM = "wizard";
const WIZARD_ID_PARAM = "id";

export function buildWizardPath(
  basePath: string,
  wizard: WizardId,
  entityId?: string
): string {
  const [pathname, existingSearch = ""] = basePath.split("?");
  const params = new URLSearchParams(existingSearch);
  params.set(WIZARD_PARAM, wizard);
  if (entityId) params.set(WIZARD_ID_PARAM, entityId);
  else params.delete(WIZARD_ID_PARAM);
  return `${pathname}?${params.toString()}`;
}

export function stripWizardParams(search: string): string {
  const params = new URLSearchParams(search);
  params.delete(WIZARD_PARAM);
  params.delete(WIZARD_ID_PARAM);
  const next = params.toString();
  return next ? `?${next}` : "";
}

export function parseWizardParam(search: string): {
  wizard: WizardId | null;
  id: string | null;
} {
  const params = new URLSearchParams(search);
  const raw = params.get(WIZARD_PARAM);
  const wizard = raw && isWizardId(raw) ? raw : null;
  return {
    wizard,
    id: params.get(WIZARD_ID_PARAM),
  };
}

function isWizardId(value: string): value is WizardId {
  return Object.values(WIZARD_IDS).some((id) => id === value);
}
