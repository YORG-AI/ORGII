import {
  type ExternalSkillsetsTab,
  extensionKindForSkillsetTab,
} from "@src/config/mainAppPaths";

import type { DetailMode, IntegrationCategory } from "./types";

export interface IntegrationsFullPageDetailInput {
  detailMode: DetailMode;
  category: IntegrationCategory;
  externalSkillsetsTab: ExternalSkillsetsTab;
  hasSelectedOrgiiAccount: boolean;
  hasSelectedDatabase: boolean;
  hasExtensionSelected: boolean;
  hasPolicySelection: boolean;
  hasRoutineSelection: boolean;
  hasConnectionSelection: boolean;
}

export function getHasIntegrationsFullPageDetail(
  input: IntegrationsFullPageDetailInput
): boolean {
  if (input.detailMode !== "full") return false;
  switch (input.category) {
    case "models":
      return input.hasSelectedOrgiiAccount;
    case "databases":
      return input.hasSelectedDatabase;
    case "tools":
    case "computerUse":
    case "myRoles":
    case "housekeeper":
    case "sessionMemoryEmbedding":
      return false;
    case "externalSkillsets":
      return (
        extensionKindForSkillsetTab(input.externalSkillsetsTab) === "mcp" &&
        input.hasExtensionSelected
      );
    case "rulesMemoryEvolution":
      return input.hasPolicySelection;
    case "routines":
      return input.hasRoutineSelection;
    case "connections":
      return input.hasConnectionSelection;
    case "git":
      return false;
    default:
      return false;
  }
}
