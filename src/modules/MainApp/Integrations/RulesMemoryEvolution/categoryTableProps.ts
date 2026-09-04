import type { ComponentProps } from "react";

import type { useRulesMemoryEvolutionState } from "../hooks/useRulesMemoryEvolutionState";
import type { AddAction } from "../types";
import type { RulesMemoryEvolutionTable } from "./Table/RulesMemoryEvolutionTable";

export type RulesMemoryEvolutionCategoryTableProps = ComponentProps<
  typeof RulesMemoryEvolutionTable
>;

export function getRulesMemoryEvolutionCategoryTableProps(params: {
  policies: ReturnType<typeof useRulesMemoryEvolutionState>;
  onAddAction: (action: AddAction) => void;
}): RulesMemoryEvolutionCategoryTableProps {
  return {
    markdownRules: params.policies.markdownRules,
    loading:
      params.policies.policiesLoading || params.policies.allRepoPoliciesLoading,
    onSelectMarkdownRule: params.policies.handleSelectMarkdownRule,
    onDeleteMarkdownRule: params.policies.handleDeleteMarkdownRuleForRow,
    onToggleMarkdownRule: params.policies.handleToggleMarkdownRuleForRow,
    onAdd: () => params.onAddAction("add-rule"),
  };
}
