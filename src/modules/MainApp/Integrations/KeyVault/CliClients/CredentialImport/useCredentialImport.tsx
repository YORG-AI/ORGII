/**
 * useCredentialImport — detect/select/apply hook for the credential
 * suggestion panel. Same shape as `useExternalImport` (skills / rules /
 * agents auto-import) so the inline panels behave identically:
 *
 *   - detection runs on mount and after every apply (the probe is offline
 *     and cheap, so the collapsed header can show a "found" count);
 *   - selection is a Set of row ids; `handleImport` applies the selection
 *     through the Rust import pipeline and surfaces a per-item report.
 *
 * Secrets never reach this hook: rows carry only fingerprints and source
 * coordinates, and the import command re-reads + validates on the Rust side.
 */
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { loadAvailableAgents } from "@src/api/services/availableAgents";
import {
  type CredentialSuggestion,
  importCredentialSuggestions,
  listCredentialSuggestions,
} from "@src/api/services/keyValidation";
import { rpc } from "@src/api/tauri/rpc";
import Button from "@src/components/Button";
import Checkbox from "@src/components/Checkbox";
import ModelIcon from "@src/components/ModelIcon";
import {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { createLogger } from "@src/hooks/logger";
import { FolderOpenIcon, HugeiconsIcon } from "@src/icons";
import { getFileManagerRevealLabelKey } from "@src/util/platform/fileManagerLabels";

import {
  SOURCE_KIND_LABEL_KEY,
  credentialImportRowKey,
  importableSuggestions,
  sortSuggestions,
} from "./credentialImportUtils";

const logger = createLogger("CredentialImport");

/** `/Users/me/.zshrc` → `~/.zshrc`; other paths pass through. */
function abbreviateHome(path: string): string {
  const match = /^(?:\/Users|\/home)\/[^/]+(\/.*)?$/.exec(path);
  return match ? `~${match[1] ?? ""}` : path;
}

export interface CredentialImportRow extends CredentialSuggestion {
  /** Registry display name for the agent / provider ("Claude Code", "Anthropic"). */
  displayName: string;
  /** Localized source-kind label ("Shell profile"). */
  sourceKindLabel: string;
}

export interface CredentialImportFailure {
  id: string;
  displayName: string;
  sourceLabel: string;
  error: string;
}

interface UseCredentialImportOptions {
  sourceKind?: CredentialSuggestion["sourceKind"];
  /** Called after a fully successful batch so the parent can collapse. */
  onCompleted: () => void;
  /** Called after any successful item so the parent can reload agents/accounts. */
  onRefresh?: () => void | Promise<void>;
}

async function loadDisplayNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const [agents, providers] = await Promise.allSettled([
    loadAvailableAgents(),
    rpc.validation.getAvailableApiProviders(),
  ]);
  if (agents.status === "fulfilled") {
    for (const agent of agents.value) names.set(agent.name, agent.displayName);
  } else {
    logger.warn("get_available_agents failed:", agents.reason);
  }
  if (providers.status === "fulfilled") {
    for (const provider of providers.value) {
      names.set(provider.name, provider.displayName);
    }
  } else {
    logger.warn("get_available_api_providers failed:", providers.reason);
  }
  return names;
}

export function useCredentialImport({
  sourceKind,
  onCompleted,
  onRefresh,
}: UseCredentialImportOptions) {
  const { t } = useTranslation("integrations");

  const [items, setItems] = useState<CredentialImportRow[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [importLoading, setImportLoading] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importErrors, setImportErrors] = useState<CredentialImportFailure[]>(
    []
  );
  const [detectionRefreshKey, setDetectionRefreshKey] = useState(0);

  const sourceKindLabel = useCallback(
    (kind: CredentialSuggestion["sourceKind"]) =>
      t(SOURCE_KIND_LABEL_KEY[kind] ?? "", { defaultValue: kind }),
    [t]
  );

  useEffect(() => {
    let cancelled = false;
    setImportLoading(true);
    setImportError(null);
    setImportErrors([]);

    Promise.all([listCredentialSuggestions(), loadDisplayNames()])
      .then(([suggestions, names]) => {
        if (cancelled) return;
        const rows: CredentialImportRow[] = suggestions
          .filter((item) => !sourceKind || item.sourceKind === sourceKind)
          .map((suggestion) => ({
            ...suggestion,
            displayName:
              names.get(suggestion.agentType) ?? suggestion.agentType,
            sourceKindLabel: sourceKindLabel(suggestion.sourceKind),
          }));
        setItems(sortSuggestions(rows));
        // Drop selections whose rows disappeared (imported or removed).
        setSelected((prev) => {
          const live = new Set(rows.map(credentialImportRowKey));
          const next = new Set([...prev].filter((key) => live.has(key)));
          return next.size === prev.size ? prev : next;
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        logger.error("list_credential_suggestions failed:", err);
        setItems([]);
      })
      .finally(() => {
        if (!cancelled) setImportLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [detectionRefreshKey, sourceKindLabel, sourceKind]);

  const allImportableItems = useMemo(
    () => importableSuggestions(items),
    [items]
  );

  const importableItems = allImportableItems;

  const allSelected =
    importableItems.length > 0 &&
    importableItems.every((row) => selected.has(credentialImportRowKey(row)));

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
      setSelected(new Set(importableItems.map(credentialImportRowKey)));
    }
  }, [allSelected, importableItems]);

  const refreshDetection = useCallback(() => {
    setDetectionRefreshKey((current) => current + 1);
  }, []);

  const handleImport = useCallback(async () => {
    if (selected.size === 0) return;

    const selections: CredentialSuggestion[] = [];
    const byId = new Map(
      items.map((row) => [credentialImportRowKey(row), row])
    );
    for (const key of selected) {
      const row = byId.get(key);
      if (!row) continue;
      // Strip the display-only fields; the Rust side deserializes the
      // suggestion shape exactly.
      const {
        displayName: _displayName,
        sourceKindLabel: _label,
        ...suggestion
      } = row;
      selections.push(suggestion);
    }

    setImporting(true);
    setImportError(null);
    setImportErrors([]);
    try {
      const report = await importCredentialSuggestions(selections);
      const failures = report.items.filter((item) => item.status === "failed");
      const importedCount = report.items.length - failures.length;

      if (failures.length > 0) {
        setImportErrors(
          failures.map((item) => ({
            id: item.id,
            displayName: byId.get(item.id)?.displayName ?? item.agentType,
            sourceLabel: item.sourceLabel,
            error: item.error ?? "Unknown error",
          }))
        );
        // Keep failed rows selected so the user can retry after fixing the
        // cause; drop the ones that landed.
        setSelected(new Set(failures.map((item) => item.id)));
      } else {
        setSelected(new Set());
      }

      if (importedCount > 0) {
        await onRefresh?.();
        refreshDetection();
      }
      if (failures.length === 0) {
        onCompleted();
      }
    } catch (err: unknown) {
      logger.error("import_credential_suggestions failed:", err);
      setImportError(err instanceof Error ? err.message : String(err));
    } finally {
      setImporting(false);
    }
  }, [selected, items, onCompleted, onRefresh, refreshDetection]);

  const handleReveal = useCallback((row: CredentialImportRow) => {
    if (!row.sourcePath) return;
    invoke("show_in_folder", { path: row.sourcePath });
  }, []);

  const importColumns = useMemo<SettingsTableColumn<CredentialImportRow>[]>(
    () => [
      {
        key: "credential",
        label: (
          <label className="flex items-center gap-3">
            <Checkbox checked={allSelected} onCheckedChange={handleSelectAll} />
            <span>{t("credentialImport.itemColumn")}</span>
          </label>
        ),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (row) => (
          <label className="flex items-center gap-3">
            <Checkbox
              checked={selected.has(credentialImportRowKey(row))}
              onCheckedChange={(checked) =>
                handleToggle(credentialImportRowKey(row), checked as boolean)
              }
            />
            <ModelIcon
              agentType={row.agentType}
              size={14}
              className="shrink-0"
            />
            <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
              {row.displayName}
            </span>
          </label>
        ),
      },
      {
        key: "source",
        label: t("credentialImport.sourceColumn"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          rowA.sourceKindLabel.localeCompare(rowB.sourceKindLabel) ||
          rowA.sourceLabel.localeCompare(rowB.sourceLabel),
        renderCell: (row) => {
          // One consolidated line: what the credential is, then where it
          // lives. The kind label is only spelled out for the keychain,
          // where there is no path to show; everywhere else the path or
          // variable name says it. Long paths truncate; the tooltip has
          // the full one.
          const authLabel = t(`credentialImport.authMethod.${row.authMethod}`, {
            defaultValue: row.authMethod,
          });
          const detail =
            row.sourceKind === "keychain" || row.sourceKind === "cc_switch"
              ? `${row.sourceKindLabel} · ${row.sourceLabel}`
              : row.sourceKind === "shell_profile" && row.sourcePath
                ? `${row.sourceLabel} · ${abbreviateHome(row.sourcePath)}`
                : row.sourceRef
                  ? `${row.sourceRef} · ${row.sourceLabel}`
                  : row.sourceLabel;
          return (
            <span
              className={`${SETTINGS_TABLE_CELL.muted} inline-flex max-w-[360px] min-w-0 items-center gap-2 whitespace-nowrap`}
              title={`${row.sourceKindLabel} · ${row.sourcePath ?? row.sourceLabel}`}
            >
              <span className="shrink-0">{authLabel}</span>
              <span className="shrink-0 text-text-4">·</span>
              <span className="min-w-0 truncate">{detail}</span>
            </span>
          );
        },
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        renderCell: (row) =>
          row.sourcePath ? (
            <Button
              variant="secondary"
              size="small"
              iconOnly
              icon={
                <HugeiconsIcon
                  icon={FolderOpenIcon}
                  data-icon="folder-open"
                  size={14}
                />
              }
              title={t(getFileManagerRevealLabelKey())}
              aria-label={t(getFileManagerRevealLabelKey())}
              onClick={() => handleReveal(row)}
            />
          ) : null,
      },
    ],
    [t, selected, allSelected, handleToggle, handleSelectAll, handleReveal]
  );

  return {
    items,
    allImportableItems,
    importableItems,
    selected,
    importLoading,
    importing,
    importError,
    importErrors,
    importColumns,
    handleImport,
    refreshDetection,
  };
}
