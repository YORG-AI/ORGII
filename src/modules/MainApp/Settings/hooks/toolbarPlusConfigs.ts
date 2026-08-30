/**
 * toolbarPlusConfigs
 *
 * Pure helper functions that build per-category plus-button dropdown items
 * and route-specific toolbar configurations for useRouteToolbarConfig.
 */
import type {
  AddAction,
  IntegrationCategory,
} from "@src/api/types/integrations";
import {
  BlocksIcon,
  CalendarArrowUpIcon,
  DatabaseIcon,
  Download01Icon,
  File02Icon,
  Key01Icon,
  McpServerIcon,
  UnplugIcon,
  WorkflowCircle05Icon,
} from "@src/icons";
import type {
  RouteToolbarConfig,
  ToolbarDropdownItem,
} from "@src/store/ui/routeToolbarAtom";

type TFn = (key: string, options?: Record<string, unknown>) => string;

export function getPlusConfigForCategory(
  category: IntegrationCategory,
  dispatch: (action: AddAction) => void,
  t: TFn
): Pick<RouteToolbarConfig, "onPlusClick" | "plusTitle" | "plusDropdownItems"> {
  switch (category) {
    case "models":
      return { plusDropdownItems: buildModelsDropdownItems(dispatch, t) };
    case "databases":
      return { plusDropdownItems: buildDatabasesDropdownItems(dispatch, t) };
    case "connections":
      return { plusDropdownItems: buildConnectionsDropdownItems(dispatch, t) };
    case "git":
      return { plusDropdownItems: buildGitDropdownItems(dispatch, t) };
    case "externalSkillsets":
      return {
        plusDropdownItems: buildExternalSkillsetsDropdownItems(dispatch, t),
      };
    case "rulesMemoryEvolution":
      return { plusDropdownItems: buildRulesDropdownItems(dispatch, t) };
    case "routines":
      return { plusDropdownItems: buildRoutinesDropdownItems(dispatch, t) };
    default:
      return {};
  }
}

function buildModelsDropdownItems(
  dispatch: (action: AddAction) => void,
  t: TFn
): ToolbarDropdownItem[] {
  return [
    {
      id: "bring-own-key",
      label: t("toolbarPlusMenu.addProviderKey"),
      icon: Key01Icon,
      onClick: () => dispatch("add-model"),
    },
  ];
}

function buildDatabasesDropdownItems(
  dispatch: (action: AddAction) => void,
  t: TFn
): ToolbarDropdownItem[] {
  return [
    {
      id: "add-database",
      label: t("toolbarPlusMenu.addDatabaseConnection"),
      icon: DatabaseIcon,
      onClick: () => dispatch("add-database"),
    },
  ];
}

function buildConnectionsDropdownItems(
  dispatch: (action: AddAction) => void,
  t: TFn
): ToolbarDropdownItem[] {
  return [
    {
      id: "add-connection",
      label: t("toolbarPlusMenu.addChannelOrService"),
      icon: UnplugIcon,
      onClick: () => dispatch("add-connection"),
    },
  ];
}

function buildGitDropdownItems(
  dispatch: (action: AddAction) => void,
  t: TFn
): ToolbarDropdownItem[] {
  return [
    {
      id: "add-git-connection",
      label: t("toolbarPlusMenu.addGitConnection"),
      icon: WorkflowCircle05Icon,
      onClick: () => dispatch("add-git-connection"),
    },
  ];
}

function buildExternalSkillsetsDropdownItems(
  dispatch: (action: AddAction) => void,
  t: TFn
): ToolbarDropdownItem[] {
  return [
    ...buildSkillsDropdownItems(dispatch, t),
    ...buildMcpDropdownItems(dispatch, t),
  ];
}

function buildMcpDropdownItems(
  dispatch: (action: AddAction) => void,
  t: TFn
): ToolbarDropdownItem[] {
  return [
    {
      id: "mcp-server",
      label: t("toolbarPlusMenu.addMcpServer"),
      icon: McpServerIcon,
      onClick: () => dispatch("add-mcp"),
    },
  ];
}

function buildSkillsDropdownItems(
  dispatch: (action: AddAction) => void,
  t: TFn
): ToolbarDropdownItem[] {
  return [
    {
      id: "create-skill",
      label: t("toolbarPlusMenu.createSkill"),
      icon: BlocksIcon,
      onClick: () => dispatch("create-skill"),
    },
    {
      id: "import-skill",
      label: t("toolbarPlusMenu.importSkill"),
      icon: Download01Icon,
      onClick: () => dispatch("import-skill"),
    },
  ];
}

function buildRoutinesDropdownItems(
  dispatch: (action: AddAction) => void,
  t: TFn
): ToolbarDropdownItem[] {
  return [
    {
      id: "add-routine",
      label: t("toolbarPlusMenu.addRoutine"),
      icon: CalendarArrowUpIcon,
      onClick: () => dispatch("add-routine"),
    },
  ];
}

function buildRulesDropdownItems(
  dispatch: (action: AddAction) => void,
  t: TFn
): ToolbarDropdownItem[] {
  return [
    {
      id: "add-rule",
      label: t("toolbarPlusMenu.createRule"),
      icon: File02Icon,
      onClick: () => dispatch("add-rule"),
    },
  ];
}
