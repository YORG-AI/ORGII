import type { CursorRepo, PolicySource } from "@src/hooks/policies";
import type { AgentDefinition } from "@src/modules/MainApp/AgentOrgs/types";
import type { RuleScopeMode } from "@src/modules/MainApp/Integrations/RulesMemoryEvolution/types";

interface MarkdownRuleData {
  name: string;
  content: string;
  source: PolicySource;
  agents: string[];
  repoPath?: string;
  /** Legacy repo include scope when editing older user rules. */
  scopeRepoIds?: string[];
}

export interface MarkdownRuleState {
  name: string;
  content: string;
  editorTab: string;
  agentIds: string[];
  source: PolicySource;
  repoId: string | null;
  scopeMode: RuleScopeMode;
  scopeRepoIds: string[];
}

export function defaultMarkdownRuleState(
  markdownRule?: MarkdownRuleData,
  defaultSource: PolicySource = "global",
  cursorRepos: CursorRepo[] = []
): MarkdownRuleState {
  const repoId = markdownRule?.repoPath
    ? (cursorRepos.find((repo) => repo.path === markdownRule.repoPath)?.path ??
      null)
    : null;
  const scopeMode: RuleScopeMode = "all";
  return {
    name: markdownRule?.name ?? "",
    content: markdownRule?.content ?? "",
    editorTab: "edit",
    agentIds: markdownRule?.agents ?? [],
    source: markdownRule?.source ?? defaultSource,
    repoId,
    scopeMode,
    scopeRepoIds: [],
  };
}

export interface PolicyRuleWizardProps {
  markdownRule?: MarkdownRuleData;
  /** Available agents (built-in + custom) for the agent selector */
  agents?: AgentDefinition[];
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
  onCancel: () => void;
  cursorRepos?: CursorRepo[];
  onAfterImport?: () => void | Promise<void>;
}
