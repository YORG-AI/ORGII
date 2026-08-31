/**
 * useEnsureAgentDefs — lightweight guard that triggers the global agent
 * definition fetch exactly once per app lifetime.
 *
 * Usage
 * -----
 * Components that read `builtInAgentsAtom` / `customAgentsAtom` directly
 * (instead of calling `useAgentDefinitions`) should call this hook once at
 * their top level:
 *
 *   const defsLoaded = useEnsureAgentDefs();
 *   const builtInAgents = useAtomValue(builtInAgentsAtom);
 *
 * If `useAgentDefinitions` is already mounted somewhere in the tree (e.g.
 * in AgentOrgsPage or SessionCreator), the atom is already populated and
 * this hook is a no-op.  If it is not mounted (e.g. when the Spotlight
 * palette opens before any agent-aware page loads), this hook fires a
 * single `agent_definitions_list_all` call and writes the result into the
 * shared atoms — exactly as `useAgentDefinitions` would.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useEffect } from "react";

import { rpc } from "@src/api/tauri/rpc";
import { createLogger } from "@src/hooks/logger";

import { INTERNAL_AGENT_IDS } from "../config/agentConstants";
import {
  agentDefsLoadedAtom,
  allAgentDefsAtom,
  builtInAgentsAtom,
  customAgentsAtom,
} from "../store/builtInAgentsAtom";

const log = createLogger("useEnsureAgentDefs");

/**
 * Returns `true` once the agent definition atoms have been populated.
 * May return `false` for a brief period on first render if the atoms
 * haven't been loaded yet.
 */
export function useEnsureAgentDefs(enabled = true): boolean {
  const loaded = useAtomValue(agentDefsLoadedAtom);
  const setAllDefs = useSetAtom(allAgentDefsAtom);
  const setBuiltInAgents = useSetAtom(builtInAgentsAtom);
  const setCustomAgents = useSetAtom(customAgentsAtom);
  const setLoaded = useSetAtom(agentDefsLoadedAtom);

  useEffect(() => {
    if (!enabled || loaded) return;

    let cancelled = false;

    void rpc.agentDef
      .listAll()
      .then((result) => {
        if (cancelled) return;
        setAllDefs(result);
        setBuiltInAgents(
          result.filter(
            (agent) => agent.builtIn && !INTERNAL_AGENT_IDS.has(agent.id)
          )
        );
        setCustomAgents(result.filter((agent) => !agent.builtIn));
        setLoaded(true);
      })
      .catch((err) => {
        log.warn("[useEnsureAgentDefs] load failed:", err);
      });

    return () => {
      cancelled = true;
    };
  }, [
    enabled,
    loaded,
    setAllDefs,
    setBuiltInAgents,
    setCustomAgents,
    setLoaded,
  ]);

  return loaded;
}
