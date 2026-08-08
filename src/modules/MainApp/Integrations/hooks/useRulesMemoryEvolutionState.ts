/**
 * Policy state & handlers for the Integrations page.
 * Manages markdown rules (rules-only), wizard state, and all CRUD operations.
 * Automation rules are managed separately by useRoutinesState.
 *
 * Wizard open-state lives in the URL via {@link useWizardParam}:
 *   ?wizard=rule-add              → create a new rule
 *   ?wizard=rule-edit&id=<name>   → edit an existing rule
 */
import { useAtomValue } from "jotai";
import { useCallback, useEffect, useMemo, useReducer, useState } from "react";

import { WIZARD_IDS } from "@src/config/mainAppPaths";
import { useWizardParam } from "@src/hooks/navigation";
import {
  type CursorRepo,
  type PolicyInfo,
  type PolicySource,
  useSharedPolicies,
} from "@src/hooks/policies";
import {
  builtInAgentsAtom,
  customAgentsAtom,
} from "@src/modules/MainApp/AgentOrgs/store/builtInAgentsAtom";
import type {
  RuleScopeMode,
  RulesMemoryEvolutionDetailState,
} from "@src/modules/MainApp/Integrations/RulesMemoryEvolution/types";
import { reposAtom } from "@src/store/repo";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";

import type { DetailMode, IntegrationCategory } from "../types";

export interface UseRulesMemoryEvolutionStateReturn {
  /** Full object matching RulesMemoryEvolutionDetailState (minus onClose, which is set by the page) */
  detailState: Omit<RulesMemoryEvolutionDetailState, "onClose">;

  /** Raw data for tableProps */
  markdownRules: PolicyInfo[];
  policiesLoading: boolean;
  allRepoPoliciesLoading: boolean;

  /** Table row-selection handler */
  handleSelectMarkdownRule: (name: string | null, mode?: DetailMode) => void;
  handleDeleteMarkdownRuleForRow: (rule: PolicyInfo) => Promise<void>;
  handleToggleMarkdownRuleForRow: (
    rule: PolicyInfo,
    enabled: boolean
  ) => Promise<void>;

  /** Reset all policy state */
  clearRulesMemoryEvolutionState: () => void;

  /** Open the wizard in "new rule" mode */
  openNewPolicyWizard: () => void;

  /** Refresh markdown rules */
  refreshAll: () => void;
}

export function useRulesMemoryEvolutionState(
  category: IntegrationCategory,
  setDetailMode: (mode: DetailMode) => void
): UseRulesMemoryEvolutionStateReturn {
  const categoryActive = category === "rulesMemoryEvolution";

  const allRepos = useAtomValue(reposAtom);
  const workspacePath = useAtomValue(activeWorkspaceRootPathAtom) || undefined;

  const {
    policies: _sharedPolicies,
    loading: policiesLoading,
    refresh: _refreshPolicies,
    readRule,
    createRule,
    updateRule: updateSharedRule,
    deleteRule,
    toggleRule: toggleSharedRule,
    setAgents,
    setScope,
    loadAllRepoPolicies,
  } = useSharedPolicies({ workspacePath, autoLoad: categoryActive });

  // Bump to force the loadAllRepoPolicies effect to re-stream after CRUD
  const [repoPoliciesVersion, bumpRepoPolicies] = useReducer(
    (count: number) => count + 1,
    0
  );

  const cursorRepos = useMemo<CursorRepo[]>(
    () =>
      allRepos
        .filter((repo): repo is typeof repo & { path: string } => !!repo.path)
        .map((repo) => ({ name: repo.name, path: repo.path })),
    [allRepos]
  );

  const repoKey = useMemo(
    () =>
      cursorRepos
        .map((repo) => repo.path)
        .sort()
        .join("\0"),
    [cursorRepos]
  );

  const [loadedRepoPolicies, setLoadedRepoPolicies] = useState<{
    key: string;
    policies: PolicyInfo[];
    done: boolean;
  } | null>(null);

  useEffect(() => {
    if (!categoryActive || cursorRepos.length === 0) return;
    let cancelled = false;
    const accumulated: PolicyInfo[] = [];

    const cancel = loadAllRepoPolicies(
      cursorRepos,
      (batch) => {
        if (cancelled) return;
        accumulated.push(...batch);
        setLoadedRepoPolicies({
          key: repoKey,
          policies: [...accumulated],
          done: false,
        });
      },
      () => {
        if (cancelled) return;
        // Commit `accumulated` directly (do NOT spread `prev`). When the
        // stream emits zero batches — e.g. the user just deleted the
        // last rule — `prev` still carries the previous stream's
        // entries, so spreading would leave the stale list visible.
        setLoadedRepoPolicies({
          key: repoKey,
          policies: [...accumulated],
          done: true,
        });
      }
    );

    return () => {
      cancelled = true;
      cancel();
    };
  }, [
    categoryActive,
    cursorRepos,
    loadAllRepoPolicies,
    repoKey,
    repoPoliciesVersion,
  ]);

  const allRepoPolicies = useMemo(
    () =>
      loadedRepoPolicies?.key === repoKey ? loadedRepoPolicies.policies : [],
    [loadedRepoPolicies, repoKey]
  );
  /** Only true while the Rules tab is active and streaming repo policies. */
  const allRepoPoliciesLoading =
    categoryActive &&
    cursorRepos.length > 0 &&
    (!loadedRepoPolicies ||
      loadedRepoPolicies.key !== repoKey ||
      !loadedRepoPolicies.done);

  const markdownRules = useMemo(
    () => allRepoPolicies.filter((policy) => policy.kind === "rule"),
    [allRepoPolicies]
  );

  // ── Selection state ──

  const [selectedMarkdownRuleName, setSelectedMarkdownRuleName] = useState<
    string | null
  >(null);
  const [editingMarkdownContent, setEditingMarkdownContent] = useState("");
  const [loadedRuleContent, setLoadedRuleContent] = useState<{
    ruleName: string;
    content: string;
  } | null>(null);

  const { wizard, openWizard, closeWizard } = useWizardParam();
  const policyWizardMode = wizard === WIZARD_IDS.RULE_ADD;
  const editingMarkdownRuleName: string | null = null;
  const selectedMarkdownRule = useMemo(
    () => markdownRules.find((rule) => rule.name === selectedMarkdownRuleName),
    [markdownRules, selectedMarkdownRuleName]
  );

  const editingMarkdownRule: PolicyInfo | undefined = useMemo(
    () => markdownRules.find((rule) => rule.name === editingMarkdownRuleName),
    [markdownRules, editingMarkdownRuleName]
  );

  // Resolve backend path lists to frontend repo IDs for the wizard form.
  // Repo paths the user has since removed from their repo list silently
  // drop out of the editing UI (but stay on disk until next save).
  const pathToId = useMemo(() => {
    const map = new Map<string, string>();
    for (const repo of allRepos) {
      if (repo.path) map.set(repo.path, repo.id);
    }
    return map;
  }, [allRepos]);

  const resolvePathsToIds = useCallback(
    (paths: string[] | undefined): string[] =>
      (paths ?? []).flatMap((path) => {
        const id = pathToId.get(path);
        return id ? [id] : [];
      }),
    [pathToId]
  );

  const editingScopeRepoIds = useMemo(
    () => resolvePathsToIds(editingMarkdownRule?.scopeRepoPaths),
    [editingMarkdownRule, resolvePathsToIds]
  );

  const builtInAgents = useAtomValue(builtInAgentsAtom);
  const customAgents = useAtomValue(customAgentsAtom);
  const allAgents = useMemo(
    () => [...builtInAgents, ...customAgents],
    [builtInAgents, customAgents]
  );

  const selectedRuleContent =
    loadedRuleContent?.ruleName === selectedMarkdownRuleName
      ? loadedRuleContent.content
      : "";

  // Auto-load markdown rule content when selected
  useEffect(() => {
    if (!selectedMarkdownRule) return;
    let cancelled = false;
    readRule(
      selectedMarkdownRule.name,
      selectedMarkdownRule.source,
      selectedMarkdownRule.repoPath
    )
      .then((content) => {
        if (!cancelled)
          setLoadedRuleContent({
            ruleName: selectedMarkdownRule.name,
            content,
          });
      })
      .catch(() => {
        if (!cancelled)
          setLoadedRuleContent({
            ruleName: selectedMarkdownRule.name,
            content: "",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [selectedMarkdownRule, readRule]);

  // ── Clear ──

  const clearRulesMemoryEvolutionState = useCallback(() => {
    setSelectedMarkdownRuleName(null);
    closeWizard();
    setEditingMarkdownContent("");
    setLoadedRuleContent(null);
  }, [closeWizard]);

  // ── Row selection handler ──

  const handleSelectMarkdownRule = useCallback(
    (name: string | null, mode?: DetailMode) => {
      setSelectedMarkdownRuleName(name);
      closeWizard();
      setDetailMode(mode ?? "preview");
    },
    [setDetailMode, closeWizard]
  );

  // ── CRUD handlers ──

  // Resolve repo IDs (frontend reposAtom UUIDs) to absolute paths — paths
  // are the stable identifier the prompt pipeline uses, so the repo-scope
  // filter must store paths, not IDs.
  const resolveRepoPaths = useCallback(
    (repoIds: string[] | undefined): string[] | undefined => {
      if (!repoIds || repoIds.length === 0) return undefined;
      const paths = repoIds
        .map((id) => allRepos.find((repo) => repo.id === id)?.path)
        .filter((p): p is string => !!p);
      return paths.length > 0 ? paths : undefined;
    },
    [allRepos]
  );

  const handleSaveMarkdownRule = useCallback(
    async (data: {
      name: string;
      content: string;
      source: PolicySource;
      agents: string[];
      isNew: boolean;
      scopeMode?: RuleScopeMode;
      scopeRepoIds?: string[];
      repoPath?: string;
    }) => {
      const isSpecific = data.scopeMode === "specific";
      const scopeIncludePaths = isSpecific
        ? resolveRepoPaths(data.scopeRepoIds)
        : undefined;
      const targetWorkspacePath =
        data.source === "workspace" ? data.repoPath : undefined;

      if (data.isNew) {
        await createRule(
          data.name,
          data.content,
          data.source,
          data.agents,
          scopeIncludePaths,
          undefined,
          targetWorkspacePath
        );
      } else if (editingMarkdownRule) {
        await updateSharedRule(
          editingMarkdownRule.name,
          data.content,
          editingMarkdownRule.source,
          editingMarkdownRule.repoPath
        );
        await setAgents(
          editingMarkdownRule.name,
          editingMarkdownRule.source,
          data.agents,
          editingMarkdownRule.repoPath
        );
        await setScope(
          editingMarkdownRule.name,
          editingMarkdownRule.source,
          scopeIncludePaths,
          undefined,
          editingMarkdownRule.repoPath
        );
      }
      closeWizard();
      setEditingMarkdownContent("");
      setSelectedMarkdownRuleName(data.name);
      bumpRepoPolicies();
    },
    [
      editingMarkdownRule,
      createRule,
      updateSharedRule,
      setAgents,
      setScope,
      resolveRepoPaths,
      closeWizard,
    ]
  );

  const handlePolicyWizardCancel = useCallback(() => {
    closeWizard();
    setEditingMarkdownContent("");
  }, [closeWizard]);

  const handleDeleteMarkdownRuleForRow = useCallback(
    async (rule: PolicyInfo) => {
      await deleteRule(rule.name, rule.source, rule.repoPath);
      setSelectedMarkdownRuleName((current) =>
        current === rule.name ? null : current
      );
      setLoadedRuleContent(null);
      bumpRepoPolicies();
    },
    [deleteRule]
  );

  const handleDeleteMarkdownRule = useCallback(async () => {
    if (!selectedMarkdownRule) return;
    await handleDeleteMarkdownRuleForRow(selectedMarkdownRule);
  }, [selectedMarkdownRule, handleDeleteMarkdownRuleForRow]);

  const handleToggleMarkdownRuleForRow = useCallback(
    async (rule: PolicyInfo, enabled: boolean) => {
      await toggleSharedRule(rule.name, enabled, rule.source, rule.repoPath);
      bumpRepoPolicies();
    },
    [toggleSharedRule]
  );

  const handleToggleMarkdownRule = useCallback(
    async (enabled: boolean) => {
      if (!selectedMarkdownRule) return;
      await handleToggleMarkdownRuleForRow(selectedMarkdownRule, enabled);
    },
    [selectedMarkdownRule, handleToggleMarkdownRuleForRow]
  );

  const openNewPolicyWizard = useCallback(() => {
    setEditingMarkdownContent("");
    openWizard(WIZARD_IDS.RULE_ADD);
  }, [openWizard]);

  // ── Assembled state (matches RulesMemoryEvolutionDetailState minus onClose) ──

  const detailState: Omit<RulesMemoryEvolutionDetailState, "onClose"> = useMemo(
    () => ({
      selectedMarkdownRule,
      selectedRuleContent,
      wizardMode: policyWizardMode,
      editingMarkdownRule,
      editingMarkdownContent,
      agents: allAgents,
      editingScopeRepoIds,
      onSaveMarkdownRule: handleSaveMarkdownRule,
      onWizardCancel: handlePolicyWizardCancel,
      onDeleteMarkdownRule: handleDeleteMarkdownRule,
      onToggleMarkdownRule: handleToggleMarkdownRule,
      readRule,
      cursorRepos,
      onAfterImport: _refreshPolicies,
    }),
    [
      selectedMarkdownRule,
      selectedRuleContent,
      policyWizardMode,
      editingMarkdownRule,
      editingMarkdownContent,
      allAgents,
      editingScopeRepoIds,
      handleSaveMarkdownRule,
      handlePolicyWizardCancel,
      handleDeleteMarkdownRule,
      handleToggleMarkdownRule,
      readRule,
      cursorRepos,
      _refreshPolicies,
    ]
  );

  const refreshAll = useCallback(() => {
    bumpRepoPolicies();
  }, []);

  return {
    detailState,
    markdownRules,
    policiesLoading,
    allRepoPoliciesLoading,
    handleSelectMarkdownRule,
    handleDeleteMarkdownRuleForRow,
    handleToggleMarkdownRuleForRow,
    clearRulesMemoryEvolutionState,
    openNewPolicyWizard,
    refreshAll,
  };
}
