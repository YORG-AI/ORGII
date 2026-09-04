import { useAtomValue } from "jotai";
import React, { useMemo } from "react";

import type { CursorRepo } from "@src/hooks/policies";
import McpAddWizard from "@src/scaffold/WizardSystem/variants/Mcp/McpAddWizard";
import { reposAtom } from "@src/store/repo";

import { McpDetailView } from "./Detail/McpDetailView";
import { McpTable } from "./Table/McpTable";
import type { McpCategoryTableProps } from "./categoryTableProps";
import type { McpDetailState } from "./types";

export const McpCategoryView: React.FC<{
  selectedId: string | null;
  mcp: McpDetailState;
  tableProps: McpCategoryTableProps;
  fullPage: boolean;
  onBack: () => void;
  onExpand?: () => void;
  onClosePreview: () => void;
}> = ({ selectedId, mcp, tableProps, fullPage, onBack }) => {
  const repos = useAtomValue(reposAtom);
  const cursorRepos = useMemo<CursorRepo[]>(
    () =>
      repos
        .filter((repo): repo is typeof repo & { path: string } => !!repo.path)
        .map((repo) => ({ name: repo.name, path: repo.path })),
    [repos]
  );

  if (mcp.addMode) {
    return (
      <McpAddWizard
        onSave={mcp.onSave}
        onTest={mcp.onTest}
        onCancel={mcp.onAddClose}
        editName={mcp.editName ?? undefined}
        editConfig={mcp.editConfig ?? undefined}
        initialScope={mcp.editName ? undefined : mcp.addScope}
      />
    );
  }

  if (fullPage && selectedId) {
    return <McpDetailView selectedId={selectedId} mcp={mcp} onBack={onBack} />;
  }

  const augmentedTableProps = {
    ...tableProps,
    tools: mcp.tools ?? [],
    resources: mcp.resources ?? [],
    onFetchTools: mcp.onFetchTools,
    cursorRepos,
    onAfterImport: mcp.onRefresh,
    selectedRowId: selectedId,
    embedded: tableProps.embedded ?? false,
  };

  return <McpTable {...augmentedTableProps} />;
};
