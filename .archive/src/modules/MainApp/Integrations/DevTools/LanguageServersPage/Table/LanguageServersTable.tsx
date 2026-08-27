import React, { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import FileTypeIcon from "@src/components/FileTypeIcon";
import { MODEL_TABLE_SWITCH_SIZE } from "@src/components/ModelTable/types";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import Switch from "@src/components/Switch";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import { StatusDot } from "../../../Tables/shared";
import { LANGUAGE_ICON_FILE } from "../config";
import type { LanguageServerInfo } from "../types";
import LanguageServerInlineExpandedCard, {
  LSP_INLINE_TAB,
  type LspHandlers,
  type LspInlineTab,
} from "./LanguageServerInlineExpandedCard";

interface LanguageServersTableProps {
  servers: LanguageServerInfo[];
  loading: boolean;
  workspacePath: string | null;
  lspHandlers?: LspHandlers;
}

const LanguageServersTable: React.FC<LanguageServersTableProps> = ({
  servers,
  loading,
  workspacePath,
  lspHandlers,
}) => {
  const { t } = useTranslation("settings");
  const { t: tCommon } = useTranslation();
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [activeInlineTab, setActiveInlineTab] = useState<LspInlineTab>(
    LSP_INLINE_TAB.STATUS
  );

  const setSingleExpanded = useCallback((server: LanguageServerInfo) => {
    setExpandedKeys((current) =>
      current.includes(server.language) ? [] : [server.language]
    );
  }, []);

  const filteredServers = useMemo(() => {
    const query = searchQuery.toLowerCase().trim();
    const seen = new Set<string>();

    return servers
      .filter((server) => {
        if (seen.has(server.displayName)) return false;
        seen.add(server.displayName);

        if (!query) return true;
        return (
          server.displayName.toLowerCase().includes(query) ||
          server.command.toLowerCase().includes(query) ||
          server.language.toLowerCase().includes(query)
        );
      })
      .sort((serverA, serverB) => {
        if (serverA.installed !== serverB.installed) {
          return serverA.installed ? -1 : 1;
        }
        return serverA.displayName.localeCompare(serverB.displayName);
      });
  }, [servers, searchQuery]);

  const columns = useMemo<SettingsTableColumn<LanguageServerInfo>[]>(() => {
    const cols: SettingsTableColumn<LanguageServerInfo>[] = [
      {
        key: "command",
        label: t("languageServersPage.tableCommand"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (serverA, serverB) =>
          serverA.command.localeCompare(serverB.command),
        renderCell: (server) => (
          <span
            className={`${SETTINGS_TABLE_CELL.primary} min-w-0 truncate font-bold`}
          >
            {server.command}
          </span>
        ),
      },
      {
        key: "name",
        label: t("languageServersPage.tableLanguage"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (serverA, serverB) =>
          serverA.displayName.localeCompare(serverB.displayName),
        renderCell: (server) => {
          const lang = server.language.toLowerCase();
          const primaryClass = "text-text-2 inline-flex items-center gap-1.5";

          if (lang === "c" || lang === "cpp") {
            return (
              <span className={primaryClass}>
                <FileTypeIcon
                  fileName="file.c"
                  size="small"
                  className="shrink-0"
                />
                <span>C</span>
                <span className="text-text-4">;</span>
                <FileTypeIcon
                  fileName="file.cpp"
                  size="small"
                  className="shrink-0"
                />
                <span>C++</span>
              </span>
            );
          }
          if (lang === "typescript" || lang === "javascript") {
            return (
              <span className={primaryClass}>
                <FileTypeIcon
                  fileName="file.ts"
                  size="small"
                  className="shrink-0"
                />
                <span>TypeScript</span>
                <span className="text-text-4">;</span>
                <FileTypeIcon
                  fileName="file.js"
                  size="small"
                  className="shrink-0"
                />
                <span>JavaScript</span>
              </span>
            );
          }
          if (lang === "css" || lang === "scss") {
            return (
              <span className={primaryClass}>
                <FileTypeIcon
                  fileName="file.css"
                  size="small"
                  className="shrink-0"
                />
                <span>CSS</span>
                <span className="text-text-4">;</span>
                <FileTypeIcon
                  fileName="file.scss"
                  size="small"
                  className="shrink-0"
                />
                <span>SCSS</span>
              </span>
            );
          }
          if (lang === "shell" || lang === "bash" || lang === "shellscript") {
            return (
              <span className={primaryClass}>
                <FileTypeIcon
                  fileName="file.sh"
                  size="small"
                  className="shrink-0"
                />
                <span>Shell</span>
                <span className="text-text-4">;</span>
                <FileTypeIcon
                  fileName="file.bash"
                  size="small"
                  className="shrink-0"
                />
                <span>Bash</span>
              </span>
            );
          }

          const iconFile = LANGUAGE_ICON_FILE[lang] ?? `file.${lang}`;
          return (
            <span className={primaryClass}>
              <FileTypeIcon
                fileName={iconFile}
                size="small"
                className="shrink-0"
              />
              {server.displayName}
            </span>
          );
        },
      },
      {
        key: "status",
        label: t("languageServersPage.tableStatus"),
        width: SETTINGS_TABLE_COL.valueMd,
        sorter: (serverA, serverB) =>
          Number(serverB.installed) - Number(serverA.installed),
        renderCell: (server) => (
          <StatusDot
            color={server.installed ? "bg-success-6" : "bg-fill-3"}
            label={
              server.installed
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
        renderCell: (server) => {
          if (!workspacePath || !server.installed || !lspHandlers) return null;
          const enabled = lspHandlers.isServerEnabled(server.language);
          const actionState = lspHandlers.getActionState(server.language);
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
                  lspHandlers.handleWorkspaceToggle(server.language, next)
                }
              />
            </div>
          );
        },
      },
    ];

    return cols;
  }, [lspHandlers, t, tCommon, workspacePath]);

  if (loading) {
    return (
      <div className="flex min-h-[200px] items-center justify-center rounded-lg bg-fill-2">
        <Placeholder variant="loading" />
      </div>
    );
  }

  return (
    <SettingsTable<LanguageServerInfo>
      hover
      columns={columns}
      rows={filteredServers}
      getRowKey={(server) => server.language}
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
        expandedRowRender: (server) => (
          <LanguageServerInlineExpandedCard
            server={server}
            activeTab={activeInlineTab}
            onActiveTabChange={setActiveInlineTab}
            lspHandlers={lspHandlers}
          />
        ),
      }}
      headerHeight="tall"
      className="table-expanded-no-hover table-settings-expanded-compact"
      emptyTitle={t("languageServersPage.noServersFound")}
      emptySubtitle={
        searchQuery ? tCommon("common.noResultsWithFilters") : undefined
      }
    />
  );
};

export default LanguageServersTable;
