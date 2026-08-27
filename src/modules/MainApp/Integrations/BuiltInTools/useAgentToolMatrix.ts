/**
 * useAgentToolMatrix
 *
 * Cross-agent view of "is tool X enabled on agent Y" used by the global
 * Built-in Tools preview pane. Lists every user-visible agent (built-ins
 * plus custom) and lets the user toggle a tool on/off for any of them
 * without having to navigate to that agent's detail view.
 *
 * Toggle writes go through `rpc.agentDef.updatePatch` directly — the same
 * RPC used by `useAgentToolEditor`. Per-agent local state is hydrated
 * lazily from `agent_definitions_list_all` so this hook does not refetch
 * on every selection change.
 */
import { useAtomValue, useSetAtom } from "jotai";
import { useCallback, useMemo } from "react";

import { rpc } from "@src/api/tauri/rpc";
import { createLogger } from "@src/hooks/logger";
import { useEnsureAgentDefs } from "@src/modules/MainApp/AgentOrgs/hooks/useEnsureAgentDefs";
import {
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";

import type {
  AgentDefinition,
  AgentToolSelection,
} from "../../AgentOrgs/types";

const log = createLogger("useAgentToolMatrix");

export interface AgentToolStateRow {
  agentId: string;
  /** Human label — `name` for the agent, falls back to id. */
  label: string;
  builtIn: boolean;
  /** True when the system allowlist pins this tool on. */
  pinned: boolean;
  /** Resolved enabled state (post-pin / post-exclude / post-user-allow). */
  enabled: boolean;
}

interface AgentRecord {
  definition: AgentDefinition;
  id: string;
  name: string;
  builtIn: boolean;
  systemRestrictToTools: string[] | null;
  userAllowedTools: Set<string>;
  excludedTools: Set<string>;
  /** Original `tools` blob, kept verbatim so partial patches don't drop
   *  unrelated keys we don't surface in the matrix. */
  toolsRaw: AgentToolSelection;
}

function parseAgent(def: AgentDefinition): AgentRecord {
  const tools: AgentToolSelection = def.tools ?? {};
  return {
    definition: def,
    id: def.id,
    name: def.name || def.id,
    builtIn: Boolean(def.builtIn),
    systemRestrictToTools: Array.isArray(tools.systemRestrictToTools)
      ? tools.systemRestrictToTools
      : null,
    userAllowedTools: new Set(
      Array.isArray(tools.userAllowedTools) ? tools.userAllowedTools : []
    ),
    excludedTools: new Set(
      Array.isArray(tools.excludedTools) ? tools.excludedTools : []
    ),
    toolsRaw: tools,
  };
}

function resolveState(record: AgentRecord, toolName: string) {
  const pinned =
    record.systemRestrictToTools !== null &&
    record.systemRestrictToTools.includes(toolName);
  if (record.excludedTools.has(toolName)) {
    return { pinned, enabled: false };
  }
  if (record.systemRestrictToTools !== null) {
    if (pinned) return { pinned, enabled: true };
    if (record.userAllowedTools.has(toolName)) return { pinned, enabled: true };
    return { pinned, enabled: false };
  }
  return { pinned, enabled: true };
}

export function useAgentToolMatrix() {
  // Ensure definitions are loaded (no-op if useAgentDefinitions is already mounted)
  const defsLoaded = useEnsureAgentDefs();
  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const customAgents = useAtomValue(customAgentsAtom);
  const setBuiltInAgents = useSetAtom(builtInAgentsAtom);
  const setCustomAgents = useSetAtom(customAgentsAtom);
  const records = useMemo(
    () => [...builtInAgents, ...customAgents].map(parseAgent),
    [builtInAgents, customAgents]
  );

  const applyDefinition = useCallback(
    (definition: AgentDefinition) => {
      const update = (current: AgentDefinition[]) =>
        current.map((entry) =>
          entry.id === definition.id ? definition : entry
        );
      if (definition.builtIn) {
        setBuiltInAgents(update);
      } else {
        setCustomAgents(update);
      }
    },
    [setBuiltInAgents, setCustomAgents]
  );

  const rowsByTool = useCallback(
    (toolName: string): AgentToolStateRow[] => {
      return records.map((record) => {
        const { pinned, enabled } = resolveState(record, toolName);
        return {
          agentId: record.id,
          label: record.name,
          builtIn: record.builtIn,
          pinned,
          enabled,
        };
      });
    },
    [records]
  );

  const toggle = useCallback(
    async (agentId: string, toolName: string, next: boolean) => {
      const record = records.find((current) => current.id === agentId);
      if (!record) return;

      const userAllowed = new Set(record.userAllowedTools);
      const excluded = new Set(record.excludedTools);
      const pinned =
        record.systemRestrictToTools !== null &&
        record.systemRestrictToTools.includes(toolName);

      if (next) {
        excluded.delete(toolName);
        if (record.systemRestrictToTools !== null && !pinned) {
          userAllowed.add(toolName);
        }
      } else {
        userAllowed.delete(toolName);
        if (!pinned) {
          excluded.add(toolName);
        }
      }

      const nextTools: AgentToolSelection = {
        ...record.toolsRaw,
        userAllowedTools: Array.from(userAllowed),
        excludedTools: Array.from(excluded),
      };
      const nextDefinition: AgentDefinition = {
        ...record.definition,
        tools: nextTools,
      };

      // The shared atoms are the frontend source of truth. Apply the
      // interaction optimistically there instead of mirroring the same data in
      // effect-synchronized component state.
      applyDefinition(nextDefinition);

      try {
        const savedDefinition = await rpc.agentDef.updatePatch({
          agentId,
          patch: {
            tools: nextTools,
          },
        });
        applyDefinition(savedDefinition as unknown as AgentDefinition);
      } catch (error) {
        log.error("[useAgentToolMatrix] toggle failed:", error);
        applyDefinition(record.definition);
      }
    },
    [applyDefinition, records]
  );

  const agentCount = records.length;

  return {
    loaded: defsLoaded,
    rowsByTool,
    toggle,
    agentCount,
  };
}

export type UseAgentToolMatrixReturn = ReturnType<typeof useAgentToolMatrix>;
