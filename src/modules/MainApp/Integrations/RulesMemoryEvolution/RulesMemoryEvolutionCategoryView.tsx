import React, { useCallback } from "react";

import PolicyRuleWizard from "@src/scaffold/WizardSystem/variants/Policy/PolicyRuleWizard";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

import MarkdownRuleDetailView from "./Detail/MarkdownRuleDetailView";
import { RulesMemoryEvolutionTable } from "./Table/RulesMemoryEvolutionTable";
import type { RulesMemoryEvolutionCategoryTableProps } from "./categoryTableProps";
import type { RulesMemoryEvolutionDetailState } from "./types";

export const RulesMemoryEvolutionCategoryView: React.FC<{
  policies: RulesMemoryEvolutionDetailState;
  tableProps: RulesMemoryEvolutionCategoryTableProps;
  fullPage: boolean;
  onBack: () => void;
  onExpand?: () => void;
}> = ({ policies, tableProps, fullPage, onBack }) => {
  const handleEditInEditor = useCallback(() => {
    const rule = policies.selectedMarkdownRule;
    if (!rule?.path) return;
    openFileInWorkStation(rule.path, { defaultPreviewMode: true });
  }, [policies.selectedMarkdownRule]);

  if (policies.wizardMode) {
    return (
      <PolicyRuleWizard
        markdownRule={
          policies.editingMarkdownRule
            ? {
                name: policies.editingMarkdownRule.name,
                content: policies.editingMarkdownContent,
                source: policies.editingMarkdownRule.source,
                agents: policies.editingMarkdownRule.agents,
                repoPath: policies.editingMarkdownRule.repoPath,
                scopeRepoIds: policies.editingScopeRepoIds,
              }
            : undefined
        }
        agents={policies.agents}
        onSaveMarkdownRule={policies.onSaveMarkdownRule}
        onCancel={policies.onWizardCancel}
        cursorRepos={policies.cursorRepos}
        onAfterImport={policies.onAfterImport}
      />
    );
  }

  if (fullPage && policies.selectedMarkdownRule) {
    return (
      <MarkdownRuleDetailView
        rule={policies.selectedMarkdownRule}
        content={policies.selectedRuleContent}
        onEdit={handleEditInEditor}
        onDelete={policies.onDeleteMarkdownRule}
        onToggle={policies.onToggleMarkdownRule}
        onBack={onBack}
      />
    );
  }

  const policySelectedRowId = policies.selectedMarkdownRule
    ? `${policies.selectedMarkdownRule.source}:${policies.selectedMarkdownRule.name}`
    : null;

  const augmentedProps: RulesMemoryEvolutionCategoryTableProps = {
    ...tableProps,
    selectedRowId: policySelectedRowId,
    cursorRepos: policies.cursorRepos,
    onAfterImport: policies.onAfterImport,
  };

  return <RulesMemoryEvolutionTable {...augmentedProps} />;
};
