/**
 * Runner-row display resolution.
 *
 * Names and icons are resolved from the live agent lists at render time rather
 * than stored on the runner, so a renamed custom agent or a re-detected CLI is
 * reflected without a migration. The runner persists ids only.
 */
import { DISPATCH_CATEGORY } from "@src/api/tauri/session";
import type { CliAgentType } from "@src/api/types/keys";
import {
  CLI_AVAILABILITY,
  type CliAvailability,
  type Runner,
  hasAgentSelected,
} from "@src/features/SessionCreator/multiRunner/contract";
import type {
  AgentDefinition,
  AvailableCliAgent,
} from "@src/modules/MainApp/AgentOrgs/types";

export interface RunnerAgentDisplay {
  label: string;
  /** Rust-agent icon id; `null` for CLI runners (which use `ModelIcon`). */
  iconId: string | null;
  cliAgentType: CliAgentType | null;
  /** False for a freshly added row that has no harness yet. */
  selected: boolean;
}

const DEFAULT_RUST_AGENT_ICON_ID = "code";

export function resolveRunnerAgentDisplay(
  runner: Runner,
  allAgents: AgentDefinition[],
  cliAgents: AvailableCliAgent[],
  unselectedLabel: string
): RunnerAgentDisplay {
  if (!hasAgentSelected(runner)) {
    return {
      label: unselectedLabel,
      iconId: null,
      cliAgentType: null,
      selected: false,
    };
  }

  if (runner.dispatchCategory === DISPATCH_CATEGORY.CLI_AGENT) {
    const cliAgentType = runner.cliAgentType as CliAgentType;
    const cli = cliAgents.find((agent) => agent.name === cliAgentType);
    return {
      label: cli?.displayName ?? cliAgentType,
      iconId: null,
      cliAgentType,
      selected: true,
    };
  }

  const definition = allAgents.find(
    (agent) => agent.id === runner.agentDefinitionId
  );
  return {
    label: definition?.name ?? runner.agentDefinitionId ?? unselectedLabel,
    iconId: definition?.iconId ?? DEFAULT_RUST_AGENT_ICON_ID,
    cliAgentType: null,
    selected: true,
  };
}

/**
 * Availability of a CLI harness for a fanned-out prompt.
 *
 * `installed` is the real signal even inside the *enabled* list: a user can
 * force-enable an agent they have not installed (`isCliAgentEnabled` lets an
 * override beat detection), and that row would fail at launch rather than at
 * pre-flight if we trusted list membership alone.
 */
export function createCliAvailabilityResolver(
  cliAgents: AvailableCliAgent[]
): (cliAgentType: CliAgentType) => CliAvailability {
  return (cliAgentType) => {
    const agent = cliAgents.find(
      (candidate) => candidate.name === cliAgentType
    );
    if (!agent?.installed) return CLI_AVAILABILITY.NOT_INSTALLED;
    if (agent.supportsGui === false) return CLI_AVAILABILITY.NO_GUI;
    return CLI_AVAILABILITY.OK;
  };
}
