import type { SessionDisplayMetadata } from "@src/util/session/sessionDisplayMetadata";

import {
  EXTERNAL_HISTORY_FILTER_BY_SOURCE,
  type KanbanAgentTypeFilter,
} from "../../config";

export interface KanbanAgentFilterProjection {
  agentTypeFilter?: KanbanAgentTypeFilter;
  agentTypeFilterKind?: "external" | "cli" | "rust";
  agentTypeFilterLabel?: string;
}

/**
 * Project the filter identity once beside the visible agent identity.
 * Board, List, Diary, and the header consume this result without returning to
 * raw local/cloud records and independently interpreting their provenance.
 */
export function resolveKanbanAgentFilter(
  display: SessionDisplayMetadata,
  agentDefinitionId?: string,
  agentDefinitionLabel?: string
): KanbanAgentFilterProjection {
  if (display.externalSource) {
    return {
      agentTypeFilter:
        EXTERNAL_HISTORY_FILTER_BY_SOURCE[display.externalSource.sourceId],
      agentTypeFilterKind: "external",
      agentTypeFilterLabel: display.externalSource.displayName,
    };
  }
  if (agentDefinitionId) {
    return {
      agentTypeFilter: agentDefinitionId,
      agentTypeFilterKind: "rust",
      // The shared display projection intentionally labels native sessions as
      // the ORG2 runtime/provider. Kanban filters identify the selected Rust
      // definition instead, so preserve its source label when available.
      agentTypeFilterLabel: agentDefinitionLabel || display.agentLabel,
    };
  }
  if (display.cliAgentType) {
    return {
      agentTypeFilter: display.cliAgentType,
      agentTypeFilterKind: "cli",
      agentTypeFilterLabel: display.agentLabel,
    };
  }
  return {};
}
