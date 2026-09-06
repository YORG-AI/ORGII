import type { UseSkillEditorReturn } from "@src/hooks/skills/useSkillEditor";
import type {
  HubSkillDetail,
  InstalledSkill,
  SkillUpdateInfo,
} from "@src/types/extensions";

export interface SkillsHubDetailState {
  installedSkills: InstalledSkill[];
  installedLoading: boolean;
  onToggleSkill: (name: string, enabled: boolean) => void;
  onUninstallSkill: (name: string) => Promise<void>;
  onReadSkill: (name: string) => Promise<string>;
  skillDetail: HubSkillDetail | null;
  detailLoading: boolean;
  detailError: string | null;
  onFetchDetail: (slug: string) => void;
  onClearDetail: () => void;
  updates: SkillUpdateInfo[];
  updatesLoading: boolean;
  onCheckUpdates: () => void;
  onUpdateSkill: (update: SkillUpdateInfo) => Promise<boolean>;
  updatingSlug: string | null;
  onRefreshInstalled: (
    workspacePaths?: string[],
    options?: { scoped?: boolean }
  ) => Promise<void>;
}

export interface SkillEditorState {
  editorMode: boolean;
  editor: UseSkillEditorReturn;
  onEditorBack: () => void;
  onEditorSaved: () => void;
  onCreateClick: () => void;
  onEditClick: (skillName: string) => void;
  /**
   * Import-from-other-agents mode (Claude Code skills directories +
   * commands files). Driven by `?wizard=skill-import` so deep-links and
   * the back button behave correctly.
   */
  importMode: boolean;
  onImportClick: () => void;
  onImportCancel: () => void;
  /** Called after a successful import so the installed list refreshes. */
  onImportRefresh: () => Promise<void>;
}
