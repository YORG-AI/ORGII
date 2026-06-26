import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import StatusDot from "@src/components/StatusDot";
import { createLogger } from "@src/hooks/logger";
import { useRefreshSpin } from "@src/hooks/ui";
import { useLanguageServers } from "@src/modules/MainApp/Integrations/hooks/lsp/useLanguageServers";
import { useLintTools } from "@src/modules/MainApp/Integrations/hooks/lsp/useLintTools";
import {
  CollapsibleSection,
  DETAIL_PANEL_TOKENS,
} from "@src/modules/shared/layouts/blocks";

import type { DetectedConfigFile, RepoType } from "../types";

const logger = createLogger("WorkspaceToolsReadiness");

interface ToolRecommendation {
  id: string;
  label: string;
}

interface WorkspaceToolsReadinessProps {
  workspacePath?: string | null;
  repoType: RepoType;
  configFiles: DetectedConfigFile[];
  hasDocker: boolean;
  hasMakefile: boolean;
}

interface ToolReadinessItem {
  id: string;
  label: string;
  installed: boolean;
  enabled: boolean;
  installHint?: string;
  kind: "lsp" | "lint";
}

interface ToolReadinessGroup {
  key: "lsp" | "lint";
  label: string;
  ready: number;
  total: number;
  missing: ToolReadinessItem[];
  disabled: ToolReadinessItem[];
}

interface WorkspaceLintToolStatus {
  name: string;
  enabled: boolean;
  installed: boolean;
}

const RECOMMENDED_LSP_BY_REPO_TYPE: Partial<
  Record<RepoType, ToolRecommendation[]>
> = {
  node: [{ id: "typescript", label: "TypeScript Language Server" }],
  rust: [{ id: "rust", label: "rust-analyzer" }],
  python: [{ id: "python", label: "Pyright" }],
  go: [{ id: "go", label: "gopls" }],
  java: [{ id: "java", label: "Java Language Server" }],
  kotlin: [{ id: "kotlin", label: "Kotlin Language Server" }],
  ruby: [{ id: "ruby", label: "Ruby LSP" }],
  php: [{ id: "php", label: "PHP Intelephense" }],
  csharp: [{ id: "csharp", label: "OmniSharp" }],
};

const RECOMMENDED_LINT_BY_REPO_TYPE: Partial<
  Record<RepoType, ToolRecommendation[]>
> = {
  node: [
    { id: "eslint", label: "ESLint" },
    { id: "prettier", label: "Prettier" },
    { id: "tsc", label: "TypeScript Compiler" },
  ],
  rust: [
    { id: "clippy", label: "Clippy" },
    { id: "rustfmt", label: "Rustfmt" },
  ],
  python: [
    { id: "ruff", label: "Ruff" },
    { id: "mypy", label: "Mypy" },
  ],
  go: [
    { id: "golangci-lint", label: "golangci-lint" },
    { id: "gofmt", label: "Gofmt" },
  ],
  ruby: [{ id: "rubocop", label: "RuboCop" }],
};

function uniqueRecommendations(
  recommendations: ToolRecommendation[]
): ToolRecommendation[] {
  const seen = new Set<string>();
  return recommendations.filter((recommendation) => {
    if (seen.has(recommendation.id)) return false;
    seen.add(recommendation.id);
    return true;
  });
}

function getConfigFileNames(configFiles: DetectedConfigFile[]): Set<string> {
  return new Set(configFiles.map((file) => file.name));
}

function getRecommendedLsp(
  repoType: RepoType,
  configFiles: DetectedConfigFile[]
): ToolRecommendation[] {
  const names = getConfigFileNames(configFiles);
  const recommendations = [...(RECOMMENDED_LSP_BY_REPO_TYPE[repoType] ?? [])];

  if (names.has("tsconfig.json")) {
    recommendations.push({
      id: "typescript",
      label: "TypeScript Language Server",
    });
  }
  if (names.has("Dockerfile")) {
    recommendations.push({
      id: "dockerfile",
      label: "Dockerfile Language Server",
    });
  }

  return uniqueRecommendations(recommendations);
}

function getRecommendedLint(
  repoType: RepoType,
  configFiles: DetectedConfigFile[],
  hasDocker: boolean,
  hasMakefile: boolean
): ToolRecommendation[] {
  const names = getConfigFileNames(configFiles);
  const recommendations = [...(RECOMMENDED_LINT_BY_REPO_TYPE[repoType] ?? [])];

  if (names.has(".eslintrc.json")) {
    recommendations.push({ id: "eslint", label: "ESLint" });
  }
  if (names.has(".prettierrc")) {
    recommendations.push({ id: "prettier", label: "Prettier" });
  }
  if (hasDocker) {
    recommendations.push({ id: "hadolint", label: "Hadolint" });
  }
  if (hasMakefile) {
    recommendations.push({ id: "shellcheck", label: "ShellCheck" });
  }

  return uniqueRecommendations(recommendations);
}

function readinessCopyKey(group: ToolReadinessGroup): string {
  if (group.total === 0) return "controlTower.workspaceTools.notApplicable";
  if (group.ready === group.total) return "controlTower.workspaceTools.ready";
  return "controlTower.workspaceTools.needsSetup";
}

export const WorkspaceToolsReadiness: React.FC<
  WorkspaceToolsReadinessProps
> = ({ workspacePath, repoType, configFiles, hasDocker, hasMakefile }) => {
  const { t } = useTranslation("sessions");
  const {
    servers,
    isLoading: lspLoading,
    isRefreshing: lspRefreshing,
    isServerEnabled,
    refresh: refreshServers,
  } = useLanguageServers({ workspacePath: workspacePath ?? null });
  const {
    lintTools,
    isLoading: lintLoading,
    isRefreshing: lintRefreshing,
    isToolEnabled,
    refresh: refreshLintTools,
  } = useLintTools({ workspacePath: workspacePath ?? null });
  const [workspaceLintState, setWorkspaceLintState] = useState<{
    tools: WorkspaceLintToolStatus[];
    requestKey: string | null;
  }>({ tools: [], requestKey: null });
  const [workspaceLintRefreshTick, setWorkspaceLintRefreshTick] = useState(0);
  const workspaceLintRequestKey = workspacePath
    ? `${workspacePath}:${workspaceLintRefreshTick}`
    : null;
  const activeWorkspaceLintTools = useMemo(
    () =>
      workspaceLintState.requestKey === workspaceLintRequestKey
        ? workspaceLintState.tools
        : [],
    [workspaceLintRequestKey, workspaceLintState]
  );

  useEffect(() => {
    if (!workspacePath || !workspaceLintRequestKey) return;

    let cancelled = false;

    invoke<WorkspaceLintToolStatus[]>("lint_scan_get_tools", { workspacePath })
      .then((tools) => {
        if (!cancelled) {
          setWorkspaceLintState({ tools, requestKey: workspaceLintRequestKey });
        }
      })
      .catch((error: unknown) => {
        logger.error("lint_scan_get_tools failed:", error);
        if (!cancelled) {
          setWorkspaceLintState({
            tools: [],
            requestKey: workspaceLintRequestKey,
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [workspacePath, workspaceLintRequestKey]);

  const recommendedLsp = useMemo(
    () => getRecommendedLsp(repoType, configFiles),
    [configFiles, repoType]
  );
  const recommendedLint = useMemo(
    () => getRecommendedLint(repoType, configFiles, hasDocker, hasMakefile),
    [configFiles, hasDocker, hasMakefile, repoType]
  );

  const groups = useMemo<ToolReadinessGroup[]>(() => {
    const lspItems: ToolReadinessItem[] = recommendedLsp.map(
      (recommendation) => {
        const server = servers.find(
          (item) => item.language === recommendation.id
        );
        return {
          id: recommendation.id,
          label: server?.displayName ?? recommendation.label,
          installed: server?.installed ?? false,
          enabled: isServerEnabled(recommendation.id),
          installHint: server?.installHint,
          kind: "lsp",
        };
      }
    );

    const lintItems: ToolReadinessItem[] = recommendedLint.map(
      (recommendation) => {
        const tool = lintTools.find((item) => item.id === recommendation.id);
        const workspaceTool = activeWorkspaceLintTools.find(
          (item) => item.name === recommendation.id
        );
        return {
          id: recommendation.id,
          label: tool?.name ?? recommendation.label,
          installed: workspaceTool?.installed ?? tool?.installed ?? false,
          enabled: workspaceTool?.enabled ?? isToolEnabled(recommendation.id),
          installHint: tool?.installHint,
          kind: "lint",
        };
      }
    );

    const buildGroup = (
      key: ToolReadinessGroup["key"],
      label: string,
      items: ToolReadinessItem[]
    ): ToolReadinessGroup => ({
      key,
      label,
      ready: items.filter((item) => item.installed && item.enabled).length,
      total: items.length,
      missing: items.filter((item) => !item.installed),
      disabled: items.filter((item) => item.installed && !item.enabled),
    });

    return [
      buildGroup("lsp", t("controlTower.workspaceTools.lsp"), lspItems),
      buildGroup("lint", t("controlTower.workspaceTools.lint"), lintItems),
    ];
  }, [
    isServerEnabled,
    isToolEnabled,
    lintTools,
    recommendedLint,
    recommendedLsp,
    servers,
    t,
    activeWorkspaceLintTools,
  ]);

  const workspaceLintLoading =
    Boolean(workspaceLintRequestKey) &&
    workspaceLintState.requestKey !== workspaceLintRequestKey;
  const loading =
    lspLoading ||
    lintLoading ||
    lspRefreshing ||
    lintRefreshing ||
    workspaceLintLoading;
  const totalRecommended = groups.reduce((sum, group) => sum + group.total, 0);
  const totalReady = groups.reduce((sum, group) => sum + group.ready, 0);
  const allReady = totalRecommended > 0 && totalReady === totalRecommended;
  const hasRecommendations = totalRecommended > 0;

  const handleRefresh = useCallback(() => {
    refreshServers();
    refreshLintTools();
    setWorkspaceLintRefreshTick((current) => current + 1);
  }, [refreshLintTools, refreshServers]);
  const refreshLabel = t("controlTower.workspaceTools.refresh");
  const { spinClass: refreshSpinClass, handleClick: handleRefreshClick } =
    useRefreshSpin(handleRefresh, loading, `workspace-tools:${workspacePath}`);

  if (!workspacePath) return null;

  return (
    <CollapsibleSection
      title={t("controlTower.workspaceTools.title")}
      defaultOpen={false}
    >
      <div className={DETAIL_PANEL_TOKENS.chatPanelInfoContainer}>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-[13px] font-semibold text-text-1">
                  {t("controlTower.workspaceTools.title")}
                </span>
                <StatusDot
                  color={allReady ? "bg-success-6" : "bg-warning-6"}
                  size="sm"
                  label={
                    hasRecommendations
                      ? t("controlTower.workspaceTools.summary", {
                          ready: totalReady,
                          total: totalRecommended,
                        })
                      : t("controlTower.workspaceTools.noRecommendations")
                  }
                  labelClassName={`text-xs font-medium ${
                    allReady ? "text-success-6" : "text-warning-6"
                  }`}
                />
              </div>
              <p className="mt-1 text-[12px] text-text-3">
                {t("controlTower.workspaceTools.description")}
              </p>
            </div>
            <Button
              variant="secondary"
              size="small"
              shape="round"
              icon={<RefreshCw size={14} className={refreshSpinClass} />}
              iconOnly
              disabled={loading}
              onClick={handleRefreshClick}
              title={refreshLabel}
              aria-label={refreshLabel}
            />
          </div>

          <div className="grid gap-2 lg:grid-cols-2">
            {groups.map((group) => (
              <div key={group.key} className="rounded-md bg-chat-pane p-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-[12px] font-semibold text-text-1">
                      {group.label}
                    </div>
                    <div className="mt-0.5 text-[11px] text-text-3">
                      {t(readinessCopyKey(group), {
                        ready: group.ready,
                        total: group.total,
                      })}
                    </div>
                  </div>
                  {group.total > 0 && group.ready === group.total ? (
                    <CheckCircle2
                      size={16}
                      className="shrink-0 text-success-6"
                    />
                  ) : (
                    <AlertTriangle
                      size={16}
                      className="shrink-0 text-warning-6"
                    />
                  )}
                </div>

                {group.missing.length > 0 || group.disabled.length > 0 ? (
                  <div className="mt-3 flex flex-col gap-1.5">
                    {[...group.missing, ...group.disabled]
                      .slice(0, 4)
                      .map((item) => (
                        <div
                          key={`${group.key}:${item.id}`}
                          className="flex min-w-0 items-center justify-between gap-2 rounded bg-fill-2 px-2 py-1.5"
                          title={item.installHint}
                        >
                          <span className="min-w-0 truncate text-[11px] text-text-1">
                            {item.label}
                          </span>
                          <span className="shrink-0 text-[10px] font-medium text-text-3">
                            {item.installed
                              ? t("controlTower.workspaceTools.disabled")
                              : t("controlTower.workspaceTools.missing")}
                          </span>
                        </div>
                      ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </CollapsibleSection>
  );
};
