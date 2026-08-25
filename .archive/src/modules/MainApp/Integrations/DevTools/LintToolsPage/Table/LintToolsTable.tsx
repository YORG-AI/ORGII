import React, {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { MODEL_TABLE_SWITCH_SIZE } from "@src/components/ModelTable/types";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import Tooltip from "@src/components/Tooltip";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import {
  getLanguageDisplayName,
  getLanguageIconFile,
} from "@src/util/language/languageMap";

import { StatusDot } from "../../../Tables/shared";
import type { LintToolInfo } from "../../LanguageServersPage/types";
import LintToolInlineExpandedCard, {
  LINT_INLINE_TAB,
  type LintHandlers,
  type LintInlineTab,
} from "./LintToolInlineExpandedCard";

const GAP = 6;
const SEPARATOR_WIDTH = 8;
const MORE_WIDTH = 36;

function LanguagesCell({ languages }: { languages: string[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [visibleCount, setVisibleCount] = useState(languages.length);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure || languages.length === 0) return;

    const update = () => {
      const containerWidth = container.clientWidth;
      const items = measure.querySelectorAll("[data-lang-item]");
      if (items.length === 0) {
        setVisibleCount(languages.length);
        return;
      }

      let totalWidth = 0;
      let count = 0;
      for (let i = 0; i < items.length; i++) {
        const itemWidth = (items[i] as HTMLElement).offsetWidth;
        const between = i > 0 ? SEPARATOR_WIDTH + GAP : 0;
        totalWidth += between + itemWidth;
        if (totalWidth + MORE_WIDTH <= containerWidth) {
          count = Math.min(i + 1, 3);
        } else {
          break;
        }
      }
      setVisibleCount(Math.max(1, count));
    };

    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [languages]);

  const resolvedVisibleCount = Math.min(visibleCount, languages.length);
  const visible = languages.slice(0, resolvedVisibleCount);
  const overflowCount = Math.max(0, languages.length - resolvedVisibleCount);

  return (
    <div
      ref={containerRef}
      className="relative flex w-full min-w-0 items-center overflow-hidden"
    >
      <div
        ref={measureRef}
        className="absolute left-[-9999px] top-0 flex items-center gap-1.5"
        aria-hidden
      >
        {languages.map((lang) => (
          <span
            key={lang}
            data-lang-item
            className="inline-flex items-center gap-1.5 text-text-2"
          >
            <FileTypeIcon
              fileName={getLanguageIconFile(lang)}
              size="small"
              className="shrink-0"
            />
            <span>{getLanguageDisplayName(lang)}</span>
          </span>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-1.5 overflow-hidden text-text-2">
        {visible.map((lang, index) => (
          <span
            key={lang}
            className="inline-flex shrink-0 items-center gap-1.5"
          >
            {index > 0 && <span className="shrink-0 text-text-4">;</span>}
            <FileTypeIcon
              fileName={getLanguageIconFile(lang)}
              size="small"
              className="shrink-0"
            />
            <span>{getLanguageDisplayName(lang)}</span>
          </span>
        ))}
        {overflowCount > 0 && (
          <>
            {visible.length > 0 && (
              <span className="shrink-0 text-text-4">;</span>
            )}
            <Tooltip content={languages.map(getLanguageDisplayName).join(", ")}>
              <span className="shrink-0 cursor-default">+{overflowCount}</span>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
}

interface LintToolsTableProps {
  lintTools: LintToolInfo[];
  loading: boolean;
  workspacePath: string | null;
  lintHandlers?: LintHandlers;
}

const LintToolsTable: React.FC<LintToolsTableProps> = ({
  lintTools,
  loading,
  workspacePath,
  lintHandlers,
}) => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [activeInlineTab, setActiveInlineTab] = useState<LintInlineTab>(
    LINT_INLINE_TAB.STATUS
  );

  const setSingleExpanded = useCallback((tool: LintToolInfo) => {
    setExpandedKeys((current) => (current.includes(tool.id) ? [] : [tool.id]));
  }, []);

  const filteredTools = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();

    return lintTools
      .filter((tool) => {
        if (!query) return true;
        return (
          tool.name.toLowerCase().includes(query) ||
          tool.languages.some((lang) => lang.toLowerCase().includes(query))
        );
      })
      .sort((toolA, toolB) => {
        if (toolA.installed !== toolB.installed) {
          return toolA.installed ? -1 : 1;
        }
        return toolA.name.localeCompare(toolB.name);
      });
  }, [lintTools, searchQuery]);

  const columns = useMemo<SettingsTableColumn<LintToolInfo>[]>(
    () => [
      {
        key: "name",
        label: t("languageServersPage.tableLintTool"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (toolA, toolB) => toolA.name.localeCompare(toolB.name),
        renderCell: (tool) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} min-w-0 truncate font-bold`}
          >
            {tool.name}
          </span>
        ),
      },
      {
        key: "languages",
        label: t("languageServersPage.tableLanguages"),
        width: SETTINGS_TABLE_COL.fill,
        renderCell: (tool) => <LanguagesCell languages={tool.languages} />,
      },
      {
        key: "version",
        label: t("languageServersPage.tableVersion"),
        width: SETTINGS_TABLE_COL.valueMd,
        renderCell: (tool) =>
          tool.installed && tool.version ? (
            <span className={SETTINGS_TABLE_CELL.value}>{tool.version}</span>
          ) : null,
      },
      {
        key: "status",
        label: t("languageServersPage.tableStatus"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (toolA, toolB) =>
          Number(toolB.installed) - Number(toolA.installed),
        renderCell: (tool) => (
          <StatusDot
            color={tool.installed ? "bg-success-6" : "bg-fill-3"}
            label={
              tool.installed
                ? t("languageServersPage.installed")
                : t("cliConfig.statusNotInstalled")
            }
          />
        ),
      },
      {
        key: "enabled",
        label: <span className="sr-only">{tCommon("labels.enabled")}</span>,
        width: SETTINGS_TABLE_COL.hug,
        align: "right",
        renderCell: (tool) => {
          if (!workspacePath || !tool.installed || !lintHandlers) return null;
          const enabled = lintHandlers.isToolEnabled(tool.id);
          const actionState = lintHandlers.getActionState(tool.id);
          const isBusy =
            actionState.status === "installing" ||
            actionState.status === "uninstalling";
          return (
            <div
              className="flex items-center justify-end gap-2 whitespace-nowrap"
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <Switch
                size={MODEL_TABLE_SWITCH_SIZE}
                checked={enabled}
                disabled={isBusy}
                onCheckedChange={(next) =>
                  lintHandlers.handleWorkspaceToggle(tool.id, next)
                }
              />
            </div>
          );
        },
      },
    ],
    [lintHandlers, t, tCommon, workspacePath]
  );

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-lg bg-fill-2">
        <Placeholder variant="loading" />
      </div>
    );
  }

  return (
    <SettingsTable<LintToolInfo>
      hover
      columns={columns}
      rows={filteredTools}
      getRowKey={(tool) => tool.id}
      onRowClick={setSingleExpanded}
      searchBar={{
        searchValue: searchQuery,
        onSearchChange: setSearchQuery,
        searchPlaceholder: tCommon("common.searchPlaceholder"),
        allowSearchClear: true,
      }}
      expandable={{
        rowExpandable: () => true,
        expandedRowKeys: expandedKeys,
        onExpandedRowsChange: (keys) => setExpandedKeys(keys.slice(-1)),
        expandedRowRender: (tool) => (
          <LintToolInlineExpandedCard
            tool={tool}
            activeTab={activeInlineTab}
            onActiveTabChange={setActiveInlineTab}
            lintHandlers={lintHandlers}
          />
        ),
      }}
      headerHeight="tall"
      className="table-expanded-no-hover table-settings-expanded-compact"
      emptyTitle={t("languageServersPage.noLintToolsFound")}
      emptySubtitle={
        searchQuery ? tCommon("common.noResultsWithFilters") : undefined
      }
    />
  );
};

export default LintToolsTable;
