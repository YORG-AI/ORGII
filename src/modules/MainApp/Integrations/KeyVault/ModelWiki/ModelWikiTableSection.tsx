import { Brain, MessageSquareText, Wrench } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import ModelIcon from "@src/components/ModelIcon";
import type { SelectOption } from "@src/components/Select";
import SettingsTable, {
  SETTINGS_TABLE_CELL,
  SETTINGS_TABLE_COL,
  type SettingsTableColumn,
  type SettingsTableSelectFilter,
} from "@src/components/SettingsTable";
import Tooltip from "@src/components/Tooltip";
import { normalizedIncludes } from "@src/util/search/fuzzy";

import {
  MODEL_WIKI_ENTRIES,
  type ModelWikiEntry,
  formatTokenCount,
} from "./modelWikiData";

const FILTER_ALL = "__all__";

const DASH = "—";

/** Month + year only, e.g. "April 2026" — no specific day. */
function formatAddedMonth(unixSeconds: number, locale: string): string {
  return new Date(unixSeconds * 1000).toLocaleDateString(locale, {
    year: "numeric",
    month: "long",
  });
}

/**
 * Display labels for OpenRouter vendor slugs whose plain capitalization
 * (or repo-org slug) doesn't match the brand name users expect to see in
 * the Provider column. Only entries that differ from the default
 * `capitalize(slug)` need to live here.
 */
const VENDOR_SLUG_DISPLAY: Record<string, string> = {
  openai: "OpenAI",
  openrouter: "OpenRouter",
  "meta-llama": "Meta",
  "anthracite-org": "Anthracite",
  rekaai: "Reka",
  moonshotai: "MoonshotAI",
  mistralai: "Mistral AI",
  alibaba: "Alibaba",
  "z-ai": "Z AI",
  ai21: "AI21",
  deepseek: "DeepSeek",
  cohere: "Cohere",
  inflection: "Inflection",
  nousresearch: "Nous Research",
  perplexity: "Perplexity",
  thudm: "THUDM",
  liquid: "Liquid",
  qwen: "Qwen",
  baidu: "Baidu",
  bytedance: "ByteDance",
  morph: "Morph",
};

/** Derive a provider display name from an OpenRouter model id like
 *  `vendor/model-slug` (or `~vendor/model-slug` for "latest" pointers). */
function providerFromId(id: string): string {
  const slug = id.replace(/^~/, "").split("/")[0];
  if (!slug) return "";
  return (
    VENDOR_SLUG_DISPLAY[slug] ?? slug.charAt(0).toUpperCase() + slug.slice(1)
  );
}

/**
 * Split an OpenRouter entry into a provider + model pair for display.
 *
 * OpenRouter `name` usually arrives as `"Vendor: Model Name"`. For
 * 7%-ish of entries (e.g. `"Google Gemini Pro Latest"`,
 * `"Anthropic Claude Sonnet Latest"`) the upstream API omits the
 * separator, so we fall back to the `id`'s vendor slug for the Provider
 * column and strip the vendor prefix from the name when present so the
 * Model column doesn't repeat it.
 */
function splitProviderModel(entry: { id: string; name: string }): {
  provider: string;
  model: string;
} {
  const separatorIndex = entry.name.indexOf(": ");
  if (separatorIndex !== -1) {
    return {
      provider: entry.name.slice(0, separatorIndex),
      model: entry.name.slice(separatorIndex + 2),
    };
  }

  const provider = providerFromId(entry.id);
  if (
    provider &&
    entry.name.toLowerCase().startsWith(`${provider.toLowerCase()} `)
  ) {
    return { provider, model: entry.name.slice(provider.length + 1) };
  }
  return { provider, model: entry.name };
}

/** Icon-only capability indicator with a hover tooltip describing support. */
function CapabilityIcon({
  active,
  icon,
  tooltip,
}: {
  active: boolean;
  icon: React.ReactNode;
  tooltip: string;
}) {
  return (
    <Tooltip content={tooltip} position="top" mouseEnterDelay={200} framedPanel>
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded ${
          active ? "bg-primary-1 text-primary-6" : "bg-fill-3 text-text-4"
        }`}
      >
        {icon}
      </span>
    </Tooltip>
  );
}

export default function ModelWikiTableSection() {
  const { t, i18n } = useTranslation("integrations");
  const [searchQuery, setSearchQuery] = useState("");
  const [providerFilter, setProviderFilter] = useState<string>(FILTER_ALL);
  const [yearFilter, setYearFilter] = useState<string>(FILTER_ALL);

  /**
   * Distinct providers and years observed in the catalog, used to populate
   * the two `selectFilters` dropdowns on the table header. Both lists are
   * derived from the same source as the rows, so they always stay in sync
   * with whatever snapshot is bundled.
   */
  const { providerOptions, yearOptions } = useMemo(() => {
    const providerCounts = new Map<string, number>();
    const yearCounts = new Map<string, number>();
    for (const entry of MODEL_WIKI_ENTRIES) {
      const { provider } = splitProviderModel(entry);
      if (provider) {
        providerCounts.set(provider, (providerCounts.get(provider) ?? 0) + 1);
      }
      const year = String(new Date(entry.created * 1000).getFullYear());
      yearCounts.set(year, (yearCounts.get(year) ?? 0) + 1);
    }
    const sortedProviders = [...providerCounts.entries()].sort(
      (pairA, pairB) => pairB[1] - pairA[1] || pairA[0].localeCompare(pairB[0])
    );
    const sortedYears = [...yearCounts.keys()].sort(
      (yearA, yearB) => Number(yearB) - Number(yearA)
    );
    const providers: SelectOption[] = [
      { value: FILTER_ALL, label: t("modelWiki.filterAllProviders") },
      ...sortedProviders.map(([provider]) => ({
        value: provider,
        label: provider,
      })),
    ];
    const years: SelectOption[] = [
      { value: FILTER_ALL, label: t("modelWiki.filterAllYears") },
      ...sortedYears.map((year) => ({ value: year, label: year })),
    ];
    return { providerOptions: providers, yearOptions: years };
  }, [t]);

  const selectFilters = useMemo<SettingsTableSelectFilter[]>(
    () => [
      {
        key: "provider",
        value: providerFilter,
        defaultValue: FILTER_ALL,
        options: providerOptions,
        onChange: (val) => setProviderFilter(String(val)),
      },
      {
        key: "year",
        value: yearFilter,
        defaultValue: FILTER_ALL,
        options: yearOptions,
        onChange: (val) => setYearFilter(String(val)),
      },
    ],
    [providerFilter, providerOptions, yearFilter, yearOptions]
  );

  const filteredRows = useMemo<ModelWikiEntry[]>(() => {
    // Normalize separators (space, dash, dot, underscore) in the query so
    // users can type "GPT 5.5" / "GPT-5.5" / "gpt_5_5" and match the same
    // row. `normalizedIncludes` does the matching half of the
    // normalization; we just need to lowercase both sides up-front since
    // the helper is case-sensitive by contract.
    const query = searchQuery.trim().toLowerCase();
    return MODEL_WIKI_ENTRIES.filter((entry) => {
      const { provider, model } = splitProviderModel(entry);
      if (providerFilter !== FILTER_ALL && provider !== providerFilter) {
        return false;
      }
      if (yearFilter !== FILTER_ALL) {
        const entryYear = String(new Date(entry.created * 1000).getFullYear());
        if (entryYear !== yearFilter) return false;
      }
      if (!query) return true;
      return (
        normalizedIncludes(entry.name.toLowerCase(), query) ||
        normalizedIncludes(entry.id.toLowerCase(), query) ||
        normalizedIncludes(provider.toLowerCase(), query) ||
        normalizedIncludes(model.toLowerCase(), query)
      );
    });
  }, [searchQuery, providerFilter, yearFilter]);

  const columns = useMemo<SettingsTableColumn<ModelWikiEntry>[]>(
    () => [
      {
        key: "provider",
        label: t("modelWiki.columnProvider"),
        width: "200px",
        sorter: (rowA, rowB) =>
          splitProviderModel(rowA).provider.localeCompare(
            splitProviderModel(rowB).provider
          ),
        renderCell: (entry) => {
          const { provider } = splitProviderModel(entry);
          return (
            <div className="flex w-full min-w-0 items-center gap-2">
              <ModelIcon modelName={entry.id} size="small" />
              <span className={`${SETTINGS_TABLE_CELL.primary} truncate`}>
                {provider || DASH}
              </span>
            </div>
          );
        },
      },
      {
        key: "model",
        label: t("modelWiki.columnModel"),
        width: SETTINGS_TABLE_COL.fill,
        sorter: (rowA, rowB) =>
          splitProviderModel(rowA).model.localeCompare(
            splitProviderModel(rowB).model
          ),
        renderCell: (entry) => {
          const { model } = splitProviderModel(entry);
          return (
            <Tooltip
              content={entry.id}
              position="top"
              mouseEnterDelay={200}
              framedPanel
            >
              <span
                className={`${SETTINGS_TABLE_CELL.primary} block truncate font-medium`}
              >
                {model}
              </span>
            </Tooltip>
          );
        },
      },
      {
        key: "context",
        label: t("modelWiki.columnContext"),
        width: "120px",
        sorter: (rowA, rowB) => rowA.contextLength - rowB.contextLength,
        renderCell: (entry) => (
          <span className="tabular-nums text-text-1">
            {formatTokenCount(entry.contextLength)}
          </span>
        ),
      },
      {
        key: "maxTokens",
        label: t("modelWiki.columnMaxTokens"),
        width: "120px",
        sorter: (rowA, rowB) => (rowA.maxTokens ?? -1) - (rowB.maxTokens ?? -1),
        renderCell: (entry) => (
          <span className="tabular-nums text-text-1">
            {entry.maxTokens === null
              ? DASH
              : formatTokenCount(entry.maxTokens)}
          </span>
        ),
      },
      {
        key: "capabilities",
        label: t("modelWiki.columnCapabilities"),
        width: "150px",
        renderCell: (entry) => (
          <div className="flex items-center gap-1.5">
            <CapabilityIcon
              active={entry.supportsTools}
              icon={<Wrench size={12} strokeWidth={2} />}
              tooltip={t(
                entry.supportsTools
                  ? "modelWiki.tipTools"
                  : "modelWiki.tipNoTools"
              )}
            />
            <CapabilityIcon
              active={entry.supportsReasoning}
              icon={<Brain size={12} strokeWidth={2} />}
              tooltip={t(
                entry.supportsReasoning
                  ? "modelWiki.tipReasoning"
                  : "modelWiki.tipNoReasoning"
              )}
            />
            <CapabilityIcon
              active={entry.supportsIncludeReasoning}
              icon={<MessageSquareText size={12} strokeWidth={2} />}
              tooltip={t(
                entry.supportsIncludeReasoning
                  ? "modelWiki.tipIncludeReasoning"
                  : "modelWiki.tipNoIncludeReasoning"
              )}
            />
          </div>
        ),
      },
      {
        key: "added",
        label: t("modelWiki.columnAdded"),
        width: "140px",
        align: "right",
        sorter: (rowA, rowB) => rowA.created - rowB.created,
        renderCell: (entry) => (
          <span className={SETTINGS_TABLE_CELL.muted}>
            {formatAddedMonth(entry.created, i18n.language)}
          </span>
        ),
      },
    ],
    [t, i18n.language]
  );

  return (
    <div className="flex flex-col gap-2">
      <SettingsTable<ModelWikiEntry>
        hover
        selectFilters={selectFilters}
        columns={columns}
        rows={filteredRows}
        getRowKey={(entry) => entry.id}
        headerHeight="tall"
        pageSize={50}
        searchBar={{
          searchValue: searchQuery,
          onSearchChange: setSearchQuery,
          searchPlaceholder: t("modelWiki.searchPlaceholder"),
          allowSearchClear: true,
        }}
        emptyTitle={t("modelWiki.noMatchingModels")}
      />
    </div>
  );
}
