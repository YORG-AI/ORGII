/**
 * ExternalImportTable — generic empty/loading/error/result presentation
 * for the unified external-import flow. Rendered by every
 * `external_import_*` wizard surface (rules / skills / agents).
 */
import { Inbox } from "lucide-react";
import React from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import SettingsTable, {
  type SettingsTableColumn,
} from "@src/components/SettingsTable";

import type { ExternalImportRow } from "./useExternalImport";

function testIdPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
}

export interface ExternalImportEmptyAction {
  label: string;
  onClick: () => void;
  variant?: "primary" | "secondary";
  dataTestId?: string;
}

export interface ExternalImportTableLabels {
  /** Plural item word ("rules", "skills", "agents"). */
  itemPlural: string;
  /** Empty-state title shown when the detector returns 0 items. */
  emptyTitle: string;
  /**
   * Optional secondary line under the empty-state title. Used to surface
   * the list of disk paths the detector scanned so the user can put a
   * file there and re-open the wizard.
   */
  emptySubtitle?: string;
  /**
   * Optional CTA on the empty state. Typically wires to "Add manually"
   * so the wizard isn't a dead end when the detector finds nothing.
   */
  emptyAction?: ExternalImportEmptyAction;
}

interface ExternalImportTableProps {
  importLoading: boolean;
  importableItems: ExternalImportRow[];
  itemsEmpty: boolean;
  importColumns: SettingsTableColumn<ExternalImportRow>[];
  importError?: string | null;
  importErrors?: { sourcePath: string; targetName: string; error: string }[];
  labels: ExternalImportTableLabels;
}

const ExternalImportTable: React.FC<ExternalImportTableProps> = ({
  importLoading,
  importableItems,
  itemsEmpty,
  importColumns,
  importError,
  importErrors,
  labels,
}) => {
  const { t } = useTranslation("integrations");

  const hasRows = importableItems.length > 0;

  if (importLoading && !hasRows) {
    return <Placeholder variant="loading" />;
  }

  if (!importLoading && itemsEmpty) {
    // Wrapper provides the visual padding the wizard pane wants and a
    // max-width so the multi-vendor subtitle wraps onto multiple lines
    // instead of overshooting the detail-panel content gutter. The
    // inner `[&>div>div]` selector targets the Placeholder's own
    // `<div className="text-center">` so wrapping does not regress
    // other Placeholder consumers.
    return (
      <div className="flex min-h-[280px] w-full items-center justify-center px-4 [&>div>div]:max-w-md [&>div>div]:break-words">
        <Placeholder
          variant="empty"
          placement="detail-panel"
          icon={<Inbox size={32} aria-hidden />}
          title={labels.emptyTitle}
          subtitle={labels.emptySubtitle}
          action={labels.emptyAction}
        />
      </div>
    );
  }

  if (!importLoading && !hasRows) {
    return (
      <div className="rounded-lg bg-fill-2 px-4 py-4">
        <Placeholder
          variant="empty"
          placement="sidebar"
          title={t("agentOrgs.allImported", {
            item: labels.itemPlural,
          })}
        />
      </div>
    );
  }

  const groups = new Map<string, ExternalImportRow[]>();
  for (const item of importableItems) {
    const key = item.targetRepoPath ?? "global";
    const existing = groups.get(key) ?? [];
    existing.push(item);
    groups.set(key, existing);
  }

  return (
    <div className="flex flex-col gap-3">
      {Array.from(groups.entries()).map(([groupKey, rows]) => {
        const firstRow = rows[0];
        const title = firstRow.targetRepoPath
          ? firstRow.repoName || firstRow.targetRepoPath
          : t("agentOrgs.externalImport.globalScope");
        const testScope = firstRow.targetRepoPath ? "repo" : "global";
        return (
          <section
            key={groupKey}
            className="flex flex-col gap-2"
            data-testid={`external-import-section-${testScope}`}
            data-target-repo-path={firstRow.targetRepoPath ?? ""}
          >
            <div className="px-1 text-[12px] font-bold text-text-2">
              {title}
            </div>
            <SettingsTable<ExternalImportRow>
              columns={importColumns}
              rows={rows}
              getRowKey={(row) =>
                `${row.sourceAgent}:${row.sourcePath}:${row.targetRepoPath ?? "global"}`
              }
              headerHeight="tall"
              rowDataTestId={(row) =>
                `external-import-row-${testIdPart(row.suggestedName)}`
              }
            />
          </section>
        );
      })}
      {importLoading && (
        <div className="rounded-lg bg-fill-2 py-2 text-center text-[12px] text-text-3">
          {t("common:status.loading")}…
        </div>
      )}
      {importError && (
        <div className="rounded border border-solid border-danger-3 bg-danger-1 px-3 py-2 text-[12px] text-danger-6">
          {t("agentOrgs.externalImport.applyFailed", {
            message: importError,
          })}
        </div>
      )}
      {importErrors && importErrors.length > 0 && (
        <div className="rounded border border-solid border-warning-3 bg-warning-1 px-3 py-2 text-[12px] text-warning-6">
          <div className="mb-1 font-bold">
            {t("agentOrgs.externalImport.partialFailure")}
          </div>
          <ul className="list-inside list-disc">
            {importErrors.map((entry) => (
              <li key={entry.sourcePath}>
                <span className="font-bold">{entry.targetName}</span>:{" "}
                {entry.error}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

export default ExternalImportTable;
