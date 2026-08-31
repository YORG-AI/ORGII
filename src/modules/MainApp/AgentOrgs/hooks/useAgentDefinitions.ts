/**
 * useAgentDefinitions — Single source of truth for agent definitions.
 *
 * Fetches ALL agent definitions (builtins + custom) from the Rust backend
 * via `agent_definitions_list_all` exactly once per app lifetime, stores
 * them in `allAgentDefsAtom`, and projects the list into:
 * - `builtInAgents`: user-visible built-ins (internal subagents filtered out)
 * - `agents`: user-created custom agents (CRUD-able)
 *
 * Multiple instances may mount in parallel (AgentOrgsPage, ChatPanel,
 * WorkItem detail, etc). Because the underlying state lives on Jotai
 * atoms, every CRUD mutation propagates to every consumer.
 *
 * Staleness: the backend emits `orgii-agent-defs-changed` on EVERY store
 * mutation (RPC commands, skills_toggle, the manage_agent_def LLM tool).
 * The first mounted instance subscribes and re-fetches, so writes from
 * outside this hook (e.g. the agent editing its own definition) propagate
 * without manual refresh calls.
 */
import { listen } from "@tauri-apps/api/event";
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { rpc } from "@src/api/tauri/rpc";
import { useMounted } from "@src/hooks/lifecycle/useMounted";
import { createLogger } from "@src/hooks/logger";

import { INTERNAL_AGENT_IDS } from "../config/agentConstants";
import {
  agentDefsLoadErrorAtom,
  agentDefsLoadedAtom,
  allAgentDefsAtom,
  builtInAgentsAtom,
  customAgentsAtom,
} from "../store/builtInAgentsAtom";
import type { AgentDefinition } from "../types";

const log = createLogger("AgentDefinitions");

// Module-level guard so concurrent first-mounts coalesce into a single
// in-flight fetch instead of racing N requests against the backend.
let inflightFetch: Promise<AgentDefinition[]> | null = null;

// Module-level guard: only one Tauri listener for the defs-changed event.
let changeListenerInstalled = false;

async function fetchAllDefs(forceFresh = false): Promise<AgentDefinition[]> {
  if (!forceFresh && inflightFetch) return inflightFetch;
  const request = rpc.agentDef.listAll();
  if (forceFresh) return request;
  inflightFetch = request.finally(() => {
    inflightFetch = null;
  });
  return inflightFetch;
}

export function useAgentDefinitions() {
  const allDefs = useAtomValue(allAgentDefsAtom);
  const setAllDefs = useSetAtom(allAgentDefsAtom);
  const setBuiltInAgents = useSetAtom(builtInAgentsAtom);
  const setCustomAgents = useSetAtom(customAgentsAtom);
  const setAgentDefsLoaded = useSetAtom(agentDefsLoadedAtom);
  const loaded = useAtomValue(agentDefsLoadedAtom);
  const loadError = useAtomValue(agentDefsLoadErrorAtom);
  const setLoadError = useSetAtom(agentDefsLoadErrorAtom);
  const [loading, setLoading] = useState(!loaded);
  const mountedRef = useMounted();
  const hasTriggeredFetchRef = useRef(false);

  const applyResult = useCallback(
    (result: AgentDefinition[]) => {
      setAllDefs(result);
      setBuiltInAgents(
        result.filter(
          (agent) => agent.builtIn && !INTERNAL_AGENT_IDS.has(agent.id)
        )
      );
      setCustomAgents(result.filter((agent) => !agent.builtIn));
      setAgentDefsLoaded(true);
      setLoadError(null);
    },
    [
      setAllDefs,
      setBuiltInAgents,
      setCustomAgents,
      setAgentDefsLoaded,
      setLoadError,
    ]
  );

  const refresh = useCallback(
    async (options?: { forceFresh?: boolean }) => {
      setLoading(true);
      try {
        const result = await fetchAllDefs(options?.forceFresh === true);
        if (mountedRef.current) {
          applyResult(result);
        }
      } catch (error) {
        log.error("[AgentDefinitions] Failed to fetch:", error);
        if (mountedRef.current) {
          setLoadError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [applyResult, setLoadError, mountedRef]
  );

  useEffect(() => {
    if (loaded || hasTriggeredFetchRef.current) {
      setLoading(false);
      return;
    }
    hasTriggeredFetchRef.current = true;
    void refresh();
  }, [loaded, refresh]);

  // Backend-driven invalidation: any store mutation (including LLM-tool
  // writes that never touch this hook) re-syncs the atoms.
  useEffect(() => {
    if (changeListenerInstalled) return;
    changeListenerInstalled = true;
    const unlistenPromise = listen("orgii-agent-defs-changed", () => {
      void fetchAllDefs(true)
        .then((result) => applyResult(result))
        .catch((error) => {
          log.error(
            "[AgentDefinitions] Failed to refresh after defs-changed:",
            error
          );
        });
    });
    return () => {
      changeListenerInstalled = false;
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [applyResult]);

  const builtInAgents = useMemo(
    () =>
      allDefs.filter(
        (agent) => agent.builtIn && !INTERNAL_AGENT_IDS.has(agent.id)
      ),
    [allDefs]
  );

  const agents = useMemo(
    () => allDefs.filter((agent) => !agent.builtIn),
    [allDefs]
  );

  const addAgent = useCallback(
    async (agent: AgentDefinition) => {
      setLoading(true);
      try {
        await rpc.agentDef.add({ agentJson: JSON.stringify(agent) });
        await refresh({ forceFresh: true });
      } catch (error) {
        log.error("[AgentDefinitions] Failed to add:", error);
        throw error;
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [refresh, mountedRef]
  );

  const removeAgent = useCallback(
    async (agentId: string) => {
      setLoading(true);
      try {
        const removed = await rpc.agentDef.remove({ agentId });
        if (!removed) {
          throw new Error(`Agent '${agentId}' was not found`);
        }
        setAllDefs((current) =>
          current.filter((agent) => agent.id !== agentId)
        );
        setCustomAgents((current) =>
          current.filter((agent) => agent.id !== agentId)
        );
        setAgentDefsLoaded(true);
        setLoadError(null);
      } catch (error) {
        log.error("[AgentDefinitions] Failed to remove:", error);
        throw error;
      } finally {
        if (mountedRef.current) setLoading(false);
      }
    },
    [mountedRef, setAgentDefsLoaded, setAllDefs, setCustomAgents, setLoadError]
  );

  return {
    /** User-visible built-in agents (from Rust, internal ones filtered out). */
    builtInAgents,
    /** User-created custom agents (CRUD-able). */
    agents,
    loading,
    loadError,
    refresh,
    addAgent,
    removeAgent,
  };
}
