import type { TFunction } from "i18next";
import { Eye } from "lucide-react";
import { useMemo } from "react";

import Button from "@src/components/Button";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import type { HubSkillResult } from "@src/types/extensions";

interface FindSkillsResultsProps {
  query: string;
  results: HubSkillResult[];
  hasSearched: boolean;
  searching: boolean;
  previewingSlug: string | null;
  canSearch: boolean;
  t: TFunction<"integrations">;
  onQueryChange: (query: string) => void;
  onClear: () => void;
  onSearch: () => Promise<void>;
  onPreview: (result: HubSkillResult) => Promise<void>;
}

export function FindSkillsResults({
  query,
  results,
  hasSearched,
  searching,
  previewingSlug,
  canSearch,
  t,
  onQueryChange,
  onClear,
  onSearch,
  onPreview,
}: FindSkillsResultsProps) {
  const columns = useMemo<SettingsTableColumn<HubSkillResult>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (result) => (
          <div className="flex min-w-0 flex-col gap-0.5">
            <span className={SETTINGS_TABLE_CELL.primary + " truncate"}>
              {result.name}
            </span>
            <span className={SETTINGS_TABLE_CELL.subtitle + " truncate"}>
              {result.slug}
            </span>
          </div>
        ),
      },
      {
        key: "source",
        label: t("common:labels.source"),
        width: SETTINGS_TABLE_COL.valueLg,
        sorter: (rowA, rowB) =>
          (rowA.source ?? "").localeCompare(rowB.source ?? ""),
        renderCell: (result) => (
          <span className={SETTINGS_TABLE_CELL.value}>
            {result.source || t("common:status.unknown")}
          </span>
        ),
      },
      {
        key: "installs",
        label: t("agentOrgs.findSkills.installs"),
        width: SETTINGS_TABLE_COL.valueLg,
        align: "right",
        sorter: (rowA, rowB) => (rowA.installs ?? 0) - (rowB.installs ?? 0),
        renderCell: (result) => (
          <span className={SETTINGS_TABLE_CELL.value}>
            {typeof result.installs === "number"
              ? result.installs.toLocaleString()
              : "—"}
          </span>
        ),
      },
      {
        key: "actions",
        label: "",
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (result) => (
          <Button
            variant="secondary"
            size="small"
            icon={<Eye size={14} />}
            loading={previewingSlug === result.slug}
            disabled={previewingSlug !== null && previewingSlug !== result.slug}
            onClick={(event) => {
              event.stopPropagation();
              void onPreview(result);
            }}
          >
            {t("common:labels.preview")}
          </Button>
        ),
      },
    ],
    [onPreview, previewingSlug, t]
  );

  return (
    <form
      className="min-w-0"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSearch) void onSearch();
      }}
    >
      <SettingsTable<HubSkillResult>
        hover
        loading={searching}
        columns={columns}
        rows={results}
        getRowKey={(result) => result.slug}
        onRowClick={(result) => void onPreview(result)}
        headerHeight="tall"
        searchBar={{
          searchValue: query,
          onSearchChange: onQueryChange,
          onSearchClear: onClear,
          searchPlaceholder: t("agentOrgs.findSkills.placeholder"),
          allowSearchClear: true,
          rightContent: (
            <Button
              variant="primary"
              size="default"
              loading={searching}
              disabled={!canSearch}
              htmlType="submit"
            >
              {t("common:actions.search")}
            </Button>
          ),
        }}
        emptyTitle={
          hasSearched
            ? t("agentOrgs.findSkills.noResults")
            : t("agentOrgs.findSkills.emptyTitle")
        }
        emptySubtitle={
          hasSearched
            ? t("agentOrgs.findSkills.noResultsDesc")
            : t("agentOrgs.findSkills.emptySubtitle")
        }
        noPx
        searchHeaderClassName="-mx-4 w-[calc(100%+2rem)]"
        className="table-settings-expanded-compact"
      />
    </form>
  );
}
