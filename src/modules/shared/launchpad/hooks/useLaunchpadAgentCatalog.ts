/**
 * Same data sources and filters as DispatchCategoryPalette:
 * - installed CLI rows from useCliAgents
 * - primary built-in Rust agents plus custom Rust definitions
 */
import { useAtomValue } from "jotai";
import { useMemo } from "react";

import {
  RUST_AGENT_TYPE,
  type RustAgentType,
} from "@src/api/tauri/agent/types";
import { useEnsureAgentDefs } from "@src/modules/MainApp/AgentOrgs/hooks/useEnsureAgentDefs";
import {
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import { useCliAgents } from "@src/modules/MainApp/Integrations/KeyVault/CliClients/hooks/useCliAgents";
import {
  cliAgentVisibilityOverridesAtom,
  isCliAgentEnabled,
} from "@src/store/session";
import { getRustAgentType } from "@src/util/session/sessionDispatch";

const DEFAULT_RUST_ORDER: readonly RustAgentType[] = [
  RUST_AGENT_TYPE.OS,
  RUST_AGENT_TYPE.SDE,
  RUST_AGENT_TYPE.WINGMAN,
  RUST_AGENT_TYPE.CUSTOM,
];

export function rustBuiltInVariantsFromDefinitions(
  builtInAgents: AgentDefinition[]
): RustAgentType[] {
  if (builtInAgents.length === 0) {
    return DEFAULT_RUST_ORDER.filter(
      (variant) => variant !== RUST_AGENT_TYPE.CUSTOM
    );
  }

  const seen = new Set<RustAgentType>();
  const ordered: RustAgentType[] = [];
  for (const definition of builtInAgents) {
    const variant = getRustAgentType(definition.id);
    if (variant === RUST_AGENT_TYPE.CUSTOM) continue;
    if (seen.has(variant)) continue;
    seen.add(variant);
    ordered.push(variant);
  }
  return ordered;
}

export function useLaunchpadAgentCatalog(enabled = true) {
  const { agents: cliAgentList, loading: cliLoading } = useCliAgents({
    enabled,
  });

  const definitionsLoaded = useEnsureAgentDefs(enabled);
  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const customAgents = useAtomValue(customAgentsAtom);
  const cliVisibilityOverrides = useAtomValue(cliAgentVisibilityOverridesAtom);

  const primaryBuiltIns = useMemo(
    () => builtInAgents.filter((agent) => agent.tier === "primary"),
    [builtInAgents]
  );

  const installedCliAgents = useMemo(
    () =>
      cliAgentList.filter(
        (agent) =>
          agent.installed &&
          isCliAgentEnabled(agent.name, agent.installed, cliVisibilityOverrides)
      ),
    [cliAgentList, cliVisibilityOverrides]
  );

  const ready = !enabled || (!cliLoading && definitionsLoaded);

  return {
    allCliAgents: cliAgentList,
    installedCliAgents,
    builtInRustAgents: primaryBuiltIns,
    customRustAgents: customAgents,
    ready,
  };
}
