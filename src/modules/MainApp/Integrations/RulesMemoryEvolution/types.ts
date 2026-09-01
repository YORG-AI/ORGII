/**
 * Markdown rule & policy types for the Rules/Memory/Evolution page.
 *
 * The old visual AutomationRule types that used to live here were removed
 * together with the unreachable workflow editor (Phase 1 of the Orgtrack PM
 * protocol migration). Recurring automation is the Routine subsystem's job.
 */
// ── Detail panel state ──
import type { CursorRepo, PolicyInfo, PolicySource } from "@src/hooks/policies";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";

// ── Rule scope ──

const RULE_SCOPE_MODES = ["all", "specific"] as const;

export type RuleScopeMode = (typeof RULE_SCOPE_MODES)[number];

export interface RulesMemoryEvolutionDetailState {
  selectedMarkdownRule: PolicyInfo | undefined;
  selectedRuleContent: string;
  wizardMode: boolean;
  editingMarkdownRule: PolicyInfo | undefined;
  editingMarkdownContent: string;
  agents: AgentDefinition[];
  onClose: () => void;
  onSaveMarkdownRule: (data: {
    name: string;
    content: string;
    source: PolicySource;
    agents: string[];
    isNew: boolean;
    scopeMode?: RuleScopeMode;
    scopeRepoIds?: string[];
    repoPath?: string;
  }) => void;
  /** Editing rule's include scope as repo IDs (resolved from backend paths). */
  editingScopeRepoIds: string[];
  onWizardCancel: () => void;
  onDeleteMarkdownRule: () => void;
  onToggleMarkdownRule: (enabled: boolean) => void;
  readRule: (
    name: string,
    source: PolicySource,
    overridePath?: string
  ) => Promise<string>;
  cursorRepos?: CursorRepo[];
  /**
   * Notifies the parent screen after the external-import wizard
   * successfully copies at least one item, so it can refresh its
   * policy list.
   */
  onAfterImport?: () => void | Promise<void>;
}
