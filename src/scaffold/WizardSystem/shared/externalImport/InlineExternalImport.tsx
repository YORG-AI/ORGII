import React, { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ItemKind } from "@src/api/types/externalImport";
import Button from "@src/components/Button";
import SettingsTable from "@src/components/SettingsTable";
import type { CursorRepo } from "@src/hooks/policies";
import {
  ChevronsDownUpIcon,
  Download01Icon,
  HugeiconsIcon,
  UnfoldMoreIcon,
} from "@src/icons";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

import {
  inlineExternalImportRowKey,
  resolveHasImportable,
} from "./inlineExternalImportUtils";
import { useExternalImport } from "./useExternalImport";

interface InlineExternalImportLabels {
  /** Section row label (title). */
  title: string;
  /** Message shown when no items were detected at all. */
  empty: string;
  /** Message shown when all detected items are already imported. */
  allImported: string;
  /** Column header for the item name column. */
  itemColumn: string;
  /** Search bar placeholder prefix (e.g. "Search"). */
  searchPlaceholder?: string;
}

interface InlineExternalImportProps {
  kind: ItemKind;
  labels: InlineExternalImportLabels;
  cursorRepos?: CursorRepo[];
  /**
   * When true the panel starts expanded and the toggle button calls
   * `onCompleted` instead of collapsing (used in wizard onboarding flows).
   */
  forceExpanded?: boolean;
  onCompleted?: () => void;
  onAfterImport?: () => void | Promise<void>;
  /** Whether to show a search bar above the table. */
  showSearch?: boolean;
  /**
   * Controls which set of items determines the "all already imported" banner.
   * - "all"  — use `allImportableItems` (shows banner only when every detected
   *            item has already been imported, regardless of current filter)
   * - "filtered" — use `importableItems` (the currently-filtered slice)
   *
   * Defaults to "all".
   */
  importableCheck?: "all" | "filtered";
}

const InlineExternalImport: React.FC<InlineExternalImportProps> = ({
  kind,
  labels,
  cursorRepos,
  forceExpanded = false,
  onCompleted,
  onAfterImport,
  showSearch = false,
  importableCheck = "all",
}) => {
  const { t } = useTranslation("integrations");
  const [manuallyExpanded, setManuallyExpanded] = useState(false);
  const expanded = forceExpanded || manuallyExpanded;

  const {
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
  } = useExternalImport({
    kind,
    active: expanded,
    cursorRepos,
    onCompleted: onCompleted ?? (() => undefined),
    onRefresh: onAfterImport,
    labels: { itemColumnHeader: labels.itemColumn },
  });

  const hasImportable = resolveHasImportable(
    importableCheck,
    allImportableItems,
    importableItems
  );

  return (
    <SectionContainer>
      <SectionRow label={labels.title}>
        <Button
          variant="secondary"
          icon={
            expanded ? (
              <HugeiconsIcon
                icon={ChevronsDownUpIcon}
                data-icon="chevrons-down-up"
                size={14}
              />
            ) : (
              <HugeiconsIcon
                icon={UnfoldMoreIcon}
                data-icon="chevrons-up-down"
                size={14}
              />
            )
          }
          onClick={() => {
            if (forceExpanded) {
              onCompleted?.();
              return;
            }
            setManuallyExpanded((current) => !current);
          }}
        >
          {t("common:actions.expand")}
        </Button>
      </SectionRow>

      {expanded && (
        <SectionRow showHeader={false} className="pt-0">
          <div className="flex flex-col gap-3">
            {importLoading && items.length === 0 ? null : items.length === 0 ? (
              <div className="rounded-md bg-fill-2 px-3 py-2 text-[12px] text-text-3">
                {labels.empty}
              </div>
            ) : !hasImportable ? (
              <div className="rounded-md bg-fill-2 px-3 py-2 text-[12px] text-text-3">
                {labels.allImported}
              </div>
            ) : (
              <SettingsTable
                columns={importColumns}
                rows={importableItems}
                getRowKey={inlineExternalImportRowKey}
                headerHeight="tall"
                {...(showSearch && {
                  searchBar: {
                    searchValue: searchQuery,
                    onSearchChange: setSearchQuery,
                    searchPlaceholder:
                      labels.searchPlaceholder ??
                      `${t("common:actions.search")} ${labels.itemColumn.toLowerCase()}...`,
                    allowSearchClear: true,
                  },
                  emptyTitle: t("common:status.noResults"),
                  searchHeaderClassName: "-mx-4 w-[calc(100%+2rem)]",
                })}
                noPx
                className="table-settings-expanded-compact"
              />
            )}

            {importError && (
              <div className="rounded border border-solid border-danger-3 bg-danger-1 px-3 py-2 text-[12px] text-danger-6">
                {t("agentOrgs.externalImport.applyFailed", {
                  message: importError,
                })}
              </div>
            )}
            {importErrors.length > 0 && (
              <div className="rounded border border-solid border-warning-3 bg-warning-1 px-3 py-2 text-[12px] text-warning-6">
                <div className="mb-1 font-bold">
                  {t("agentOrgs.externalImport.partialFailure")}
                </div>
                <ul className="list-inside list-disc">
                  {importErrors.map((entry) => (
                    <li key={`${entry.sourcePath}:${entry.targetName}`}>
                      <span className="font-bold">{entry.targetName}</span>:{" "}
                      {entry.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {hasImportable && (
              <div className="flex justify-end">
                <Button
                  variant="primary"
                  size="small"
                  icon={
                    <HugeiconsIcon
                      icon={Download01Icon}
                      data-icon="download"
                      size={14}
                    />
                  }
                  disabled={selected.size === 0}
                  loading={importing}
                  onClick={handleImport}
                >
                  {t("agentOrgs.importSelected", { count: selected.size })}
                </Button>
              </div>
            )}
          </div>
        </SectionRow>
      )}
    </SectionContainer>
  );
};

export default InlineExternalImport;
