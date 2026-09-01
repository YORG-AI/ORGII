/**
 * useExternalImport — generic detect/select/apply hook for the unified
 * `external_import_*` Tauri commands. Drives the import step for every
 * `ItemKind` (rules, skills, agent definitions); the kind-specific
 * wrappers (`useImportExternalRules`, `useImportExternalSkills`,
 * `useImportExternalAgentDefinitions`) just pin the `kind` filter so
 * each wizard surfaces only its own flavor of artifact.
 *
 * Detection runs once per repo in `cursorRepos` plus a single
 * user-global pass (`repoPath: null`). Each row carries its own
 * `targetRepoPath`, so one ORGII workspace can import into multiple repos
 * without collapsing them into a single import destination.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  externalImportApply,
  externalImportDetect,
} from "@src/api/tauri/externalImport";
import type {
  DetectedItem,
  ImportSelection,
  ItemKind,
  SourceAgent,
} from "@src/api/types/externalImport";
import { CLI_AGENT, type ModelType } from "@src/api/types/keys";
import AnyIcon from "@src/components/AnyIcon";
import Checkbox from "@src/components/Checkbox";
import Dropdown from "@src/components/Dropdown";
import Menu from "@src/components/Menu";
import ModelIcon from "@src/components/ModelIcon";
import {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import SplitButton from "@src/components/SplitButton";
import { createLogger } from "@src/hooks/logger";
import type { CursorRepo } from "@src/hooks/policies";
import {
  CodeXmlIcon,
  HugeiconsIcon,
  ShieldAlertIcon,
  UserIcon,
} from "@src/icons";
import { getFileManagerRevealLabelKey } from "@src/util/platform/fileManagerLabels";
import { openFileInWorkStation } from "@src/util/ui/openFileInWorkStation";

const logger = createLogger("ExternalImport");

export interface ExternalImportRow extends DetectedItem {
  /** Friendly repo label for the destination repo, empty for global-only flows. */
  repoName: string;
  /** Destination repo for repo-scoped imports. */
  targetRepoPath: string | null;
}

function rowKey(row: ExternalImportRow): string {
  return `${row.sourceAgent}\0${row.sourcePath}\0${row.suggestedName}\0${row.targetRepoPath ?? ""}`;
}

const SOURCE_LABEL_KEY: Record<SourceAgent, string> = {
  cursor_ide: "agentOrgs.externalImport.sources.cursor_ide",
  claude_code: "agentOrgs.externalImport.sources.claude_code",
  copilot: "agentOrgs.externalImport.sources.copilot",
  kiro: "agentOrgs.externalImport.sources.kiro",
  codex: "agentOrgs.externalImport.sources.codex",
};

const SOURCE_LABEL_FALLBACK: Record<SourceAgent, string> = {
  cursor_ide: "Cursor",
  claude_code: "Claude Code",
  copilot: "GitHub Copilot",
  kiro: "Kiro",
  codex: "Codex",
};

const SOURCE_ICON_MODEL_TYPE: Record<SourceAgent, ModelType> = {
  cursor_ide: CLI_AGENT.CURSOR,
  claude_code: CLI_AGENT.CLAUDE_CODE,
  copilot: CLI_AGENT.COPILOT,
  kiro: CLI_AGENT.KIRO,
  codex: CLI_AGENT.CODEX,
};

interface ExternalImportColumnLabels {
  /** Header for the leftmost (item-name) column. */
  itemColumnHeader: string;
}

interface UseExternalImportOptions {
  /** Kind filter applied to detector output. */
  kind: ItemKind;
  /** Triggered only when the parent surface is on the import step. */
  active: boolean;
  /** Repos whose repo-local sources should be scanned. */
  cursorRepos?: CursorRepo[];
  /** Called after a successful batch apply so the parent can dismiss. */
  onCompleted: () => void;
  /**
   * Called after a successful apply so the parent can reload its lists.
   * Receives the distinct destination repo paths that were imported into
   * (repo-scoped imports), so the parent can refresh those workspace scopes
   * in addition to the global one. Global-only imports pass an empty array.
   */
  onRefresh?: (importedRepoPaths: string[]) => void | Promise<void>;
  /** Localized column labels (kind-specific item header). */
  labels: ExternalImportColumnLabels;
}

export function useExternalImport({
  kind,
  active,
  cursorRepos,
  onCompleted,
  onRefresh,
  labels,
}: UseExternalImportOptions) {
  const { t } = useTranslation("integrations");

  const [items, setItems] = useState<ExternalImportRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importLoading, setImportLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<
    { sourcePath: string; targetName: string; error: string }[]
  >([]);
  const [actionsDropdownRowKey, setActionsDropdownRowKey] = useState<
    string | null
  >(null);
  const [detectionRefreshKey, setDetectionRefreshKey] = useState(0);
  const [searchQuery, setSearchQuery] = useState("");

  const sourceLabel = useCallback(
    (row: Pick<ExternalImportRow, "sourceAgent" | "kind" | "sourcePath">) => {
      const baseLabel =
        row.sourceAgent === "cursor_ide"
          ? SOURCE_LABEL_FALLBACK.cursor_ide
          : t(SOURCE_LABEL_KEY[row.sourceAgent], {
              defaultValue: SOURCE_LABEL_FALLBACK[row.sourceAgent],
            });

      if (row.kind === "mcp") {
        return `${baseLabel} MCP`;
      }

      if (row.kind === "skill") {
        if (/[/\\]commands[/\\]/.test(row.sourcePath)) {
          return `${baseLabel} Commands`;
        }
        return `${baseLabel} Skills`;
      }

      if (row.kind === "policy") {
        if (row.sourceAgent === "cursor_ide") return `${baseLabel} Rules`;
        if (row.sourceAgent === "claude_code") return `${baseLabel} Memory`;
        if (row.sourceAgent === "copilot") return `${baseLabel} Instructions`;
        if (row.sourceAgent === "kiro") return `${baseLabel} Steering`;
      }

      if (row.kind === "agent_definition") {
        return `${baseLabel} Agents`;
      }

      return baseLabel;
    },
    [t]
  );

  const allImportableItems = useMemo(
    () => items.filter((row) => !row.alreadyImported),
    [items]
  );

  const importableItems = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    if (!query) return allImportableItems;
    return allImportableItems.filter((row) => {
      const targetScope = row.targetRepoPath
        ? row.repoName || row.targetRepoPath
        : t("mcp.userScopeLabel");
      return (
        row.suggestedName.toLowerCase().includes(query) ||
        row.sourcePath.toLowerCase().includes(query) ||
        sourceLabel(row).toLowerCase().includes(query) ||
        targetScope.toLowerCase().includes(query)
      );
    });
  }, [allImportableItems, searchQuery, sourceLabel, t]);

  const allSelected =
    importableItems.length > 0 &&
    importableItems.every((row) => selected.has(rowKey(row)));

  // Stable cache key so the effect only re-runs when the actual repo
  // set changes (NOT on every render that recreates the array).
  const repoKey = useMemo(
    () =>
      (cursorRepos ?? [])
        .map((repo) => repo.path)
        .sort()
        .join("\0"),
    [cursorRepos]
  );

  useEffect(() => {
    if (!active) {
      // The panel/wizard closed (or never opened). Reset the detection
      // loading flag so a previously in-flight detection that was superseded
      // here doesn't leave the import UI stuck on a spinner — the `.finally`
      // below skips its reset when `cancelled` is true, which would otherwise
      // require a full page refresh to recover.
      setImportLoading(false);
      return;
    }

    let cancelled = false;
    setImportLoading(true);
    setItems([]);
    setSelected(new Set());
    setImportError(null);
    setImportErrors([]);

    const repoMap = new Map<string, string>();
    for (const repo of cursorRepos ?? []) {
      repoMap.set(repo.path, repo.name);
    }

    const tasks: Promise<{
      targetRepoPath: string | null;
      items: DetectedItem[];
    }>[] = [
      externalImportDetect().then((items) => ({ targetRepoPath: null, items })),
    ];
    if (kind !== "skill") {
      for (const repo of cursorRepos ?? []) {
        tasks.push(
          externalImportDetect(repo.path).then((items) => ({
            targetRepoPath: repo.path,
            items,
          }))
        );
      }
    }

    Promise.allSettled(tasks)
      .then((results) => {
        if (cancelled) return;

        const seen = new Set<string>();
        const merged: ExternalImportRow[] = [];

        for (const result of results) {
          if (result.status !== "fulfilled") {
            logger.error("external_import_detect failed:", result.reason);
            continue;
          }
          for (const item of result.value.items) {
            if (item.kind !== kind) continue;
            if (
              kind === "skill" &&
              item.sourceScope.kind === "workspace_local"
            ) {
              continue;
            }
            const targetRepoPath =
              item.kind === "agent_definition"
                ? null
                : result.value.targetRepoPath;
            const rowIdentity = `${item.sourcePath}\0${item.suggestedName}\0${targetRepoPath ?? ""}`;
            if (seen.has(rowIdentity)) continue;
            seen.add(rowIdentity);
            const repoName = targetRepoPath
              ? (repoMap.get(targetRepoPath) ?? "")
              : "";
            merged.push({
              ...item,
              repoName,
              targetRepoPath,
            });
          }
        }

        merged.sort((a, b) => {
          const targetA = a.targetRepoPath ?? "";
          const targetB = b.targetRepoPath ?? "";
          const targetCmp = targetA.localeCompare(targetB);
          if (targetCmp !== 0) return targetCmp;
          const sourceCmp = a.sourceAgent.localeCompare(b.sourceAgent);
          if (sourceCmp !== 0) return sourceCmp;
          return a.suggestedName.localeCompare(b.suggestedName);
        });

        setItems(merged);
      })
      .finally(() => {
        if (!cancelled) setImportLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [active, kind, repoKey, cursorRepos, detectionRefreshKey]);

  const handleToggle = useCallback((key: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(key);
      else next.delete(key);
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(importableItems.map(rowKey)));
    }
  }, [allSelected, importableItems]);

  const handleImport = useCallback(async () => {
    if (selected.size === 0) return;

    const selections: ImportSelection[] = [];
    for (const key of selected) {
      const match = items.find((row) => rowKey(row) === key);
      if (!match) continue;
      selections.push({
        sourceAgent: match.sourceAgent,
        sourceScope: match.sourceScope,
        kind: match.kind,
        sourcePath: match.sourcePath,
        targetRepoPath: match.targetRepoPath,
        targetName: match.suggestedName,
      });
    }

    // Distinct repo destinations touched by this batch, so the parent can
    // refresh those workspace scopes (repo-scoped skills only show up when
    // their repo path is queried). Empty for global-only imports.
    const importedRepoPaths = Array.from(
      new Set(
        selections
          .map((selection) => selection.targetRepoPath)
          .filter((path): path is string => Boolean(path))
      )
    );

    setImporting(true);
    setImportError(null);
    setImportErrors([]);
    try {
      const report = await externalImportApply(selections);
      const failures = report.items.filter(
        (item) => item.status === "failed" || item.status === "skipped"
      );
      if (failures.length > 0) {
        setImportErrors(
          failures.map((item) => ({
            sourcePath: item.sourcePath,
            targetName: item.targetName,
            error: item.error ?? "Unknown error",
          }))
        );
        if (failures.length < selections.length) {
          setSelected(new Set());
          await onRefresh?.(importedRepoPaths);
          setDetectionRefreshKey((current) => current + 1);
        }
        return;
      }
      setSelected(new Set());
      await onRefresh?.(importedRepoPaths);
      setDetectionRefreshKey((current) => current + 1);
      onCompleted();
    } catch (err: unknown) {
      logger.error("external_import_apply failed:", err);
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [selected, items, onCompleted, onRefresh]);

  const handleOpen = useCallback((row: ExternalImportRow) => {
    openFileInWorkStation(row.sourcePath, { defaultPreviewMode: true });
    setActionsDropdownRowKey(null);
  }, []);

  const handleReveal = useCallback((row: ExternalImportRow) => {
    invoke("show_in_folder", { path: row.sourcePath });
    setActionsDropdownRowKey(null);
  }, []);

  const importColumns = useMemo<SettingsTableColumn<ExternalImportRow>[]>(
    () => [
      {
        key: "name",
        label: (
          <label className="flex items-center gap-3">
            <Checkbox checked={allSelected} onCheckedChange={handleSelectAll} />
            <span>{labels.itemColumnHeader}</span>
          </label>
        ),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => {
          const readonlyWarning = row.fidelityWarnings.find(
            (warning) => warning.kind === "readonly_downgraded"
          );
          return (
            <label className="flex flex-col gap-1">
              <div className="flex items-center gap-3">
                <Checkbox
                  checked={selected.has(rowKey(row))}
                  onCheckedChange={(checked) =>
                    handleToggle(rowKey(row), checked as boolean)
                  }
                />
                <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
                  {row.suggestedName}
                </span>
              </div>
              {readonlyWarning && (
                <div
                  className="inline-flex items-center gap-1 rounded border border-solid border-warning-3 bg-warning-1 px-2 py-0.5 text-[11px] text-warning-6"
                  title={t(
                    "agentOrgs.externalImport.readonlyDowngradedTooltip",
                    {
                      tools: readonlyWarning.excludedTools.join(", "),
                    }
                  )}
                >
                  <HugeiconsIcon
                    icon={ShieldAlertIcon}
                    data-icon="shield-alert"
                    size={12}
                    aria-hidden
                  />
                  <span>
                    {t("agentOrgs.externalImport.readonlyDowngradedBadge")}
                  </span>
                </div>
              )}
            </label>
          );
        },
      },
      {
        key: "scope",
        label: t("common:selectors.shared.workspace"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) => {
          const labelA = rowA.targetRepoPath
            ? rowA.repoName || rowA.targetRepoPath
            : t("mcp.userScopeLabel");
          const labelB = rowB.targetRepoPath
            ? rowB.repoName || rowB.targetRepoPath
            : t("mcp.userScopeLabel");
          return labelA.localeCompare(labelB);
        },
        renderCell: (row) => {
          const Icon = row.targetRepoPath ? CodeXmlIcon : UserIcon;
          return (
            <span
              className={`${SETTINGS_TABLE_CELL.muted} inline-flex items-center gap-2 whitespace-nowrap`}
            >
              <AnyIcon icon={Icon} size={14} className="shrink-0" aria-hidden />
              <span>
                {row.targetRepoPath
                  ? row.repoName || row.targetRepoPath
                  : t("mcp.userScopeLabel")}
              </span>
            </span>
          );
        },
      },
      {
        key: "source",
        label: t("common:filters.source"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          sourceLabel(rowA).localeCompare(sourceLabel(rowB)),
        renderCell: (row) => (
          <span
            className={`${SETTINGS_TABLE_CELL.muted} inline-flex items-center gap-2 whitespace-nowrap`}
          >
            <ModelIcon
              agentType={SOURCE_ICON_MODEL_TYPE[row.sourceAgent]}
              size={14}
              className="shrink-0"
            />
            <span>{sourceLabel(row)}</span>
          </span>
        ),
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (row) => {
          const actionKey = rowKey(row);
          const dropdownVisible = actionsDropdownRowKey === actionKey;
          return (
            <SplitButton
              variant="secondary"
              size="small"
              onClick={() => handleOpen(row)}
              menu={
                <Dropdown
                  droplist={
                    <Menu>
                      <Menu.Item
                        key="open-to-right"
                        onClick={() => handleOpen(row)}
                      >
                        {t("common:actions.openToRight")}
                      </Menu.Item>
                      <Menu.Item
                        key="reveal-in-file-manager"
                        onClick={() => handleReveal(row)}
                      >
                        {t(getFileManagerRevealLabelKey())}
                      </Menu.Item>
                    </Menu>
                  }
                  trigger="click"
                  position="bottom-end"
                  popupVisible={dropdownVisible}
                  onVisibleChange={(visible) =>
                    setActionsDropdownRowKey(visible ? actionKey : null)
                  }
                  getPopupContainer={() => document.body}
                  avoidViewportOverflow
                  className="z-[9999]"
                  style={{ zIndex: 9999 }}
                >
                  <div />
                </Dropdown>
              }
              onMenuButtonClick={(event) => {
                event.stopPropagation();
                setActionsDropdownRowKey(dropdownVisible ? null : actionKey);
              }}
              menuOpen={dropdownVisible}
              menuButtonLabel={t("common:actions.view")}
              widthMode="hug"
            >
              {t("common:actions.view")}
            </SplitButton>
          );
        },
      },
    ],
    [
      t,
      labels.itemColumnHeader,
      selected,
      allSelected,
      handleToggle,
      handleSelectAll,
      handleOpen,
      handleReveal,
      actionsDropdownRowKey,
      sourceLabel,
    ]
  );

  return {
    items,
    allImportableItems,
    importableItems,
    searchQuery,
    setSearchQuery,
    selected,
    importLoading,
    importing,
    importError,
    importErrors,
    importColumns,
    handleImport,
  };
}
