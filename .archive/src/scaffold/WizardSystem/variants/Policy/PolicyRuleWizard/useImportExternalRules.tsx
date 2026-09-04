/**
 * useImportExternalRules — thin wrapper around the shared
 * `useExternalImport` hook that pins the `kind` filter to "policy" so
 * PolicyRuleWizard's import step only surfaces rule-flavored artifacts
 * (Cursor IDE rules, Claude Code memory, GitHub Copilot instructions,
 * Kiro steering). Skill / AgentDefinition imports use the equivalent
 * wrappers from `shared/externalImport`.
 */
import { useTranslation } from "react-i18next";

import type { CursorRepo } from "@src/hooks/policies";
import {
  type ExternalImportRow,
  useExternalImport,
} from "@src/scaffold/WizardSystem/shared/externalImport/useExternalImport";

export type ExternalRuleRow = ExternalImportRow;

interface UseImportExternalRulesOptions {
  active: boolean;
  cursorRepos?: CursorRepo[];
  onCompleted?: () => void;
  onRefresh?: () => void | Promise<void>;
}

export function useImportExternalRules({
  active,
  cursorRepos,
  onCompleted = () => {},
  onRefresh,
}: UseImportExternalRulesOptions) {
  const { t } = useTranslation("integrations");

  const result = useExternalImport({
    kind: "policy",
    active,
    cursorRepos,
    onCompleted,
    onRefresh,
    labels: {
      itemColumnHeader: t("agentOrgs.importRuleColumn"),
    },
  });

  return {
    rules: result.items,
    allImportableRules: result.allImportableItems,
    importableRules: result.importableItems,
    searchQuery: result.searchQuery,
    setSearchQuery: result.setSearchQuery,
    selected: result.selected,
    importLoading: result.importLoading,
    importing: result.importing,
    importError: result.importError,
    importErrors: result.importErrors,
    importColumns: result.importColumns,
    handleImport: result.handleImport,
  };
}
