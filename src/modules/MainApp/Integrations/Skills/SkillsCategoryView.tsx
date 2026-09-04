import { useAtomValue } from "jotai";
import React, { Suspense, lazy, useMemo } from "react";

import type { CursorRepo } from "@src/hooks/policies";
import { DetailPanelContainer } from "@src/modules/shared/layouts/blocks";
import { reposAtom } from "@src/store/repo";

import { SkillsTable } from "./Table/SkillsTable";
import type { SkillsCategoryTableProps } from "./categoryTableProps";
import type { SkillEditorState, SkillsHubDetailState } from "./types";

// Lazy: the skill editor embeds a CodeMirror editor. Settings/Integrations
// is reachable from every settings surface, but the editor only mounts once
// the user opens a skill for editing.
const SkillEditorPanel = lazy(
  () => import("@src/scaffold/WizardSystem/variants/Skill/SkillEditorPanel")
);

export const SkillsCategoryView: React.FC<{
  selectedId: string | null;
  skillsHub: SkillsHubDetailState;
  skillEditor: SkillEditorState;
  tableProps: SkillsCategoryTableProps;
  fullPage: boolean;
  onBack: () => void;
  onExpand?: () => void;
  onClosePreview: () => void;
  hideTabHeader?: boolean;
}> = ({ selectedId, skillsHub, skillEditor, tableProps }) => {
  const repos = useAtomValue(reposAtom);
  const cursorRepos = useMemo<CursorRepo[]>(
    () =>
      repos
        .filter((repo): repo is typeof repo & { path: string } => !!repo.path)
        .map((repo) => ({ name: repo.name, path: repo.path })),
    [repos]
  );

  if (skillEditor.editorMode) {
    return (
      <Suspense fallback={null}>
        <SkillEditorPanel
          editor={skillEditor.editor}
          onBack={skillEditor.onEditorBack}
          onSaved={skillEditor.onEditorSaved}
        />
      </Suspense>
    );
  }
  const augmentedTableProps: SkillsCategoryTableProps = {
    ...tableProps,
    selectedRowId: selectedId,
    embedded: true,
    hubDetail: skillsHub.skillDetail,
    onToggleSkill: skillsHub.onToggleSkill,
    onUninstallSkill: skillsHub.onUninstallSkill,
    cursorRepos,
    importExpanded: skillEditor.importMode,
    onImportCompleted: skillEditor.onImportCancel,
    onAfterImport: skillEditor.onImportRefresh,
  };

  return (
    <DetailPanelContainer>
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <SkillsTable {...augmentedTableProps} />
      </div>
    </DetailPanelContainer>
  );
};
