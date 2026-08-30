/**
 * CursorPluginsTab — installed Cursor plugins with inline-expand detail rows.
 *
 * Uses the same SettingsTable + expandable pattern as LanguageServersTable.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { rpc } from "@src/api/tauri/rpc";
import type { CursorPluginInfo } from "@src/api/tauri/rpc/procedures/agentOrgs";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
} from "@src/components/SettingsTable";
import { createLogger } from "@src/hooks/logger";
import { useCopyCheck } from "@src/hooks/ui";
import {
  ClipboardIcon,
  FlashIcon,
  HugeiconsIcon,
  PuzzleIcon,
  ServerStack01Icon,
  Tick01Icon,
} from "@src/icons";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  ScrollPreservation,
} from "@src/modules/shared/layouts/blocks";
import { copyText } from "@src/util/data/clipboard";

import CursorPluginInlineExpandedCard from "./CursorPluginInlineExpandedCard";
import { BRAND_BG } from "./pluginBrandColors";
import { getMcpServerNames, usePluginLogo } from "./usePluginLogo";

const logger = createLogger("CursorPluginsTab");
const PLUGIN_CAPABILITY_COLUMN_WIDTH = "96px";

const PluginLogoCell: React.FC<{
  slug: string;
  logoPath: string | null;
  name: string;
}> = ({ slug, logoPath, name }) => {
  const { src, monochrome } = usePluginLogo(logoPath);
  const brandBg = BRAND_BG[slug];

  if (src) {
    return (
      <img
        src={src}
        alt={name}
        style={{
          background: monochrome && brandBg ? brandBg : undefined,
          filter: monochrome && !brandBg ? "invert(1)" : undefined,
        }}
        className="h-7 w-7 shrink-0 rounded-lg object-contain p-1"
      />
    );
  }
  return (
    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-fill-3">
      <HugeiconsIcon
        icon={PuzzleIcon}
        data-icon="puzzle"
        size={13}
        className="text-text-3"
      />
    </div>
  );
};

function buildAllMcpConfig(plugins: CursorPluginInfo[]): string {
  const merged: Record<string, unknown> = {};
  for (const plugin of plugins) {
    const serverNames = getMcpServerNames(
      plugin.mcpConfig as Record<string, unknown> | null
    );
    if (serverNames.length === 0 || !plugin.mcpConfig) continue;
    const servers = (plugin.mcpConfig as Record<string, unknown>)["mcpServers"];
    if (servers && typeof servers === "object" && !Array.isArray(servers)) {
      Object.assign(merged, servers as Record<string, unknown>);
    }
  }
  return JSON.stringify({ mcpServers: merged }, null, 2);
}

const CopyAllButton: React.FC<{ plugins: CursorPluginInfo[] }> = ({
  plugins,
}) => {
  const { t } = useTranslation("integrations");
  const hasMcp = plugins.some((p) => !!p.mcpConfig);
  const onCopy = useCallback(
    async () => copyText(buildAllMcpConfig(plugins)),
    [plugins]
  );
  const { copied, handleCopy } = useCopyCheck(onCopy);
  if (!hasMcp) return null;
  return (
    <div className="flex items-center px-4 py-2">
      <button
        onClick={handleCopy}
        className="inline-flex items-center gap-1.5 rounded px-2 py-1.5 text-[12px] text-text-3 transition-colors hover:bg-fill-2 hover:text-text-1"
      >
        {copied ? (
          <HugeiconsIcon icon={Tick01Icon} data-icon="check" size={12} />
        ) : (
          <HugeiconsIcon icon={ClipboardIcon} data-icon="clipboard" size={12} />
        )}
        {copied ? t("common:status.copied") : t("cursorPlugins.copyAllMcp")}
      </button>
    </div>
  );
};

const CursorPluginsTab: React.FC = () => {
  const { t } = useTranslation("integrations");

  const [plugins, setPlugins] = useState<CursorPluginInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    rpc.agentOrgs.cursor
      .listPlugins()
      .then((result) => {
        if (!cancelled) {
          setPlugins(result);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        logger.error("Failed to load Cursor plugins", err);
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setSingleExpanded = useCallback((plugin: CursorPluginInfo) => {
    setExpandedKeys((current) =>
      current.includes(plugin.slug) ? [] : [plugin.slug]
    );
  }, []);

  const filtered = useMemo(() => {
    if (!searchQuery) return plugins;
    const query = searchQuery.toLowerCase();
    return plugins.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.description.toLowerCase().includes(query) ||
        p.slug.toLowerCase().includes(query)
    );
  }, [plugins, searchQuery]);

  const columns = useMemo<SettingsTableColumn<CursorPluginInfo>[]>(
    () => [
      {
        key: "name",
        label: t("common:labels.name"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) => rowA.name.localeCompare(rowB.name),
        renderCell: (plugin) => (
          <div className="flex items-center gap-2.5">
            <PluginLogoCell
              slug={plugin.slug}
              logoPath={plugin.logoPath}
              name={plugin.name}
            />
            <span className={`${SETTINGS_TABLE_CELL.primary} font-bold`}>
              {plugin.name}
            </span>
          </div>
        ),
      },
      {
        key: "version",
        label: t("common:labels.version"),
        width: SETTINGS_TABLE_COL.valueSm,
        sorter: (rowA, rowB) =>
          (rowA.version ?? "").localeCompare(rowB.version ?? ""),
        renderCell: (plugin) => (
          <span className={`${SETTINGS_TABLE_CELL.muted} whitespace-nowrap`}>
            {plugin.version ? `v${plugin.version}` : "—"}
          </span>
        ),
      },
      {
        key: "mcp",
        label: "MCP",
        width: PLUGIN_CAPABILITY_COLUMN_WIDTH,
        align: "center",
        renderCell: (plugin) =>
          plugin.mcpConfig ? (
            <HugeiconsIcon
              icon={ServerStack01Icon}
              data-icon="server"
              size={13}
              className="mx-auto text-text-3"
            />
          ) : null,
      },
      {
        key: "skills",
        label: t("externalSkillsets.tabs.skills"),
        width: PLUGIN_CAPABILITY_COLUMN_WIDTH,
        align: "center",
        sorter: (rowA, rowB) => rowA.skills.length - rowB.skills.length,
        renderCell: (plugin) =>
          plugin.skills.length > 0 ? (
            <span className="inline-flex items-center justify-center gap-1 whitespace-nowrap text-[12px] text-text-3">
              <HugeiconsIcon icon={FlashIcon} data-icon="zap" size={11} />
              {plugin.skills.length}
            </span>
          ) : null,
      },
      {
        key: "hooks",
        label: "Hooks",
        width: PLUGIN_CAPABILITY_COLUMN_WIDTH,
        align: "center",
        renderCell: (plugin) =>
          plugin.hooks.length > 0 ? (
            <HugeiconsIcon
              icon={PuzzleIcon}
              data-icon="puzzle"
              size={13}
              className="mx-auto text-text-3"
            />
          ) : null,
      },
    ],
    [t]
  );

  return (
    <DetailPanelContainer>
      <ScrollPreservation className={DETAIL_PANEL_TOKENS.scrollContentNoTop}>
        <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
          <SettingsTable<CursorPluginInfo>
            hover
            loading={loading}
            columns={columns}
            rows={filtered}
            getRowKey={(p) => p.slug}
            onRowClick={setSingleExpanded}
            expandable={{
              rowExpandable: () => true,
              expandedRowKeys: expandedKeys,
              onExpandedRowsChange: (keys) => setExpandedKeys(keys.slice(-1)),
              expandedRowRender: (plugin) => (
                <CursorPluginInlineExpandedCard plugin={plugin} />
              ),
            }}
            headerHeight="tall"
            className="table-expanded-no-hover table-settings-expanded-compact"
            searchBar={{
              searchValue: searchQuery,
              onSearchChange: setSearchQuery,
              searchPlaceholder: t("cursorPlugins.searchPlaceholder"),
              allowSearchClear: true,
            }}
            emptyTitle={t("cursorPlugins.noPlugins")}
            footer={<CopyAllButton plugins={plugins} />}
          />
        </div>
      </ScrollPreservation>
    </DetailPanelContainer>
  );
};

export default CursorPluginsTab;
