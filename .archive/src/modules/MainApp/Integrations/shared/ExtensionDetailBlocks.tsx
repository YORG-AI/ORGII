/**
 * ExtensionDetailBlocks — shared building blocks for all extension detail panels.
 *
 * Exports:
 * - ExtensionHero: title, metadata rows, description
 * - ExtensionContentTabs: pill-style tab switch for arbitrary content sections
 * - Utility helpers: stripFrontmatter, formatDate, formatNumber, skillsShUrl
 *
 * Used by Skills and MCP detail panels.
 */
import React, { useMemo, useState } from "react";

import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import {
  Calendar01Icon,
  Download01Icon,
  GitCommitHorizontalIcon,
  HugeiconsIcon,
  Refresh04Icon,
  StarIcon,
  UserIcon,
} from "@src/icons";
import type { HubSkillDetail } from "@src/types/extensions";

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

export const SKILLS_SH_BASE_URL = "https://skills.sh";

const FRONTMATTER_RE = /^---\s*\n[\s\S]*?\n---\s*\n?/;

export function stripFrontmatter(md: string): string {
  return md.replace(FRONTMATTER_RE, "").trimStart();
}

export function formatDate(timestamp: number): string {
  const d = new Date(timestamp);
  const date = d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${date}, ${time}`;
}

export function formatNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

export function skillsShUrl(detail: HubSkillDetail): string {
  return `${SKILLS_SH_BASE_URL}/${detail.slug}`;
}

// ---------------------------------------------------------------------------
// ExtensionHero
// ---------------------------------------------------------------------------

export interface MetadataItem {
  icon?: React.ReactNode;
  label: string;
}

interface ExtensionHeroProps {
  name: string;
  /** Skill hub detail — when provided, renders owner/stats/version rows */
  detail?: HubSkillDetail | null;
  description?: string;
  /** Custom metadata rows used instead of detail-based rows. */
  metadata?: MetadataItem[][];
  className?: string;
}

const ExtensionHero: React.FC<ExtensionHeroProps> = ({
  name,
  detail,
  description,
  metadata,
  className = "mb-4",
}) => {
  const resolvedName = detail?.name ?? name;
  const resolvedDescription = detail?.description ?? description;

  const skillMetaRows: MetadataItem[][] = detail
    ? [
        [
          ...(detail.owner
            ? [
                {
                  icon: detail.owner.image ? (
                    <img
                      src={detail.owner.image}
                      alt={detail.owner.displayName ?? detail.owner.handle}
                      className="size-4 rounded-full"
                    />
                  ) : (
                    <HugeiconsIcon icon={UserIcon} data-icon="user" size={12} />
                  ),
                  label: detail.owner.displayName ?? detail.owner.handle,
                },
              ]
            : []),
          ...(detail.stats
            ? [
                {
                  icon: (
                    <HugeiconsIcon
                      icon={Download01Icon}
                      data-icon="download"
                      size={12}
                    />
                  ),
                  label: formatNumber(detail.stats.downloads),
                },
                {
                  icon: (
                    <HugeiconsIcon icon={StarIcon} data-icon="star" size={12} />
                  ),
                  label: formatNumber(detail.stats.stars),
                },
              ]
            : []),
        ],
        [
          ...(detail.version
            ? [
                {
                  icon: (
                    <HugeiconsIcon
                      icon={GitCommitHorizontalIcon}
                      data-icon="git-commit-horizontal"
                      size={12}
                    />
                  ),
                  label: detail.version,
                },
              ]
            : []),
          ...(detail.createdAt
            ? [
                {
                  icon: (
                    <HugeiconsIcon
                      icon={Calendar01Icon}
                      data-icon="calendar"
                      size={12}
                    />
                  ),
                  label: formatDate(detail.createdAt),
                },
              ]
            : []),
          ...(detail.updatedAt
            ? [
                {
                  icon: (
                    <HugeiconsIcon
                      icon={Refresh04Icon}
                      data-icon="refresh-cw"
                      size={12}
                    />
                  ),
                  label: formatDate(detail.updatedAt),
                },
              ]
            : []),
        ],
      ].filter((row) => row.length > 0)
    : [];

  const rows = metadata ?? skillMetaRows;

  return (
    <div className={className}>
      <h2 className="text-lg font-semibold text-text-1">{resolvedName}</h2>
      {rows.map((row, rowIdx) => (
        <div
          key={rowIdx}
          className="mt-1 flex h-7 flex-wrap items-center gap-3 text-xs text-text-2"
        >
          {row.map((item, itemIdx) => (
            <span
              key={itemIdx}
              className={`flex items-center ${itemIdx === 0 && rowIdx === 0 && detail?.owner ? "gap-1.5" : "gap-1"}`}
            >
              {item.icon}
              {item.label}
            </span>
          ))}
        </div>
      ))}
      {resolvedDescription && (
        <p className="mt-2 text-sm leading-relaxed text-text-2">
          {resolvedDescription}
        </p>
      )}
    </div>
  );
};

export default ExtensionHero;

// ---------------------------------------------------------------------------
// ExtensionContentTabs
// ---------------------------------------------------------------------------

export interface ContentSection {
  key: string;
  label: string;
  content: React.ReactNode;
}

interface ExtensionContentTabsProps {
  sections: ContentSection[];
  /** Default active tab key. Falls back to first section. */
  defaultTab?: string;
}

export const ExtensionContentTabs: React.FC<ExtensionContentTabsProps> = ({
  sections,
  defaultTab,
}) => {
  const tabs = useMemo<TabPillItem[]>(
    () => sections.map(({ key, label }) => ({ key, label })),
    [sections]
  );

  const [activeSection, setActiveSection] = useState(
    defaultTab ?? sections[0]?.key ?? ""
  );

  if (sections.length === 0) return null;

  const resolvedTab =
    tabs.find((tab) => tab.key === activeSection)?.key ?? tabs[0]?.key;

  const activeContent = sections.find(
    (section) => section.key === resolvedTab
  )?.content;

  return (
    <div className="flex flex-col gap-3">
      {tabs.length > 1 && (
        <TabPill
          tabs={tabs}
          activeTab={resolvedTab}
          onChange={setActiveSection}
          variant="pill"
          fillWidth={false}
        />
      )}
      <div>{activeContent}</div>
    </div>
  );
};
