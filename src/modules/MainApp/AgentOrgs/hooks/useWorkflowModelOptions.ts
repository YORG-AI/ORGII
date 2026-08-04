/**
 * useWorkflowModelOptions / useWorkflowAgentOptions
 *
 * Live select-option lists for the workflow EditPanel's `model-select` and
 * `agent-select` inputs. Replaces the hardcoded `AVAILABLE_MODELS` /
 * `AVAILABLE_AGENTS` arrays in `data/types.ts`, which were stale: they
 * listed models that may not be configured (or omitted ones that are)
 * and forced the user to type unverified model IDs.
 *
 * Sources of truth:
 * - models: KeyVault accounts \u2192 `enabledModels` (the same registry that
 *   the integrations page and the runtime use).
 * - agents: `useAgentDefinitions().builtInAgents + agents` (the same
 *   registry surfaced in the AgentOrgs Agents tab).
 *
 * Both hooks return arrays of `{ label, value }` ready to feed into the
 * `Select` component used by `EditPanel`.
 */
import { useMemo } from "react";

import {
  accountHasModel,
  useModelAccountLookup,
} from "@src/hooks/models/useModelAccountLookup";
import { formatModelNameFull } from "@src/util/formatModelName";

import { useAgentDefinitions } from "./useAgentDefinitions";

export interface WorkflowSelectOption {
  label: string;
  value: string;
}

/**
 * Live, deduplicated list of models that the user has connected & enabled
 * in at least one provider account. Sorted alphabetically by formatted
 * display name to match the integrations table.
 */
export function useWorkflowModelOptions(): WorkflowSelectOption[] {
  const { accounts } = useModelAccountLookup();

  return useMemo(() => {
    const enabled = new Set<string>();
    for (const account of accounts) {
      for (const modelId of account.enabledModels ?? []) {
        if (accountHasModel(account, modelId)) enabled.add(modelId);
      }
    }
    return Array.from(enabled)
      .map((value) => ({ value, label: formatModelNameFull(value) }))
      .sort((a, b) => a.label.localeCompare(b.label));
  }, [accounts]);
}

/**
 * Live agent list \u2014 unions user-visible builtins with custom agents.
 * Each option's `value` is the agent definition id; the label is the
 * agent's `name` field, falling back to the id if missing.
 */
export function useWorkflowAgentOptions(): WorkflowSelectOption[] {
  const { builtInAgents, agents } = useAgentDefinitions();

  return useMemo(() => {
    const seen = new Set<string>();
    const out: WorkflowSelectOption[] = [];
    for (const def of [...builtInAgents, ...agents]) {
      if (!def.id || seen.has(def.id)) continue;
      seen.add(def.id);
      out.push({ value: def.id, label: def.name || def.id });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  }, [builtInAgents, agents]);
}
