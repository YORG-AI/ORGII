import type {
  BrowserHistoryEntry,
  BrowserSession,
} from "@/src/engines/BrowserCore/types";
import React, { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { FaviconIcon } from "@src/components/FaviconIcon";
import { Placeholder } from "@src/components/Placeholder";
import { TreeRowBase, type TreeRowNode } from "@src/components/TreeRow";
import { Clock01Icon, HugeiconsIcon } from "@src/icons";
import { getSiteNameFromUrl } from "@src/store/ui/navigationSidebarTabsAtom";
import { isPlaceholderBrowserSessionTitle } from "@src/store/workstation/browser/tabs";

interface BrowserHistoryListEntry extends BrowserHistoryEntry {
  id: string;
}

interface BrowserHistoryGroups {
  today: BrowserHistoryListEntry[];
  last7Days: BrowserHistoryListEntry[];
  last30Days: BrowserHistoryListEntry[];
}

interface HistoryTabProps {
  sessions: BrowserSession[];
  onOpenHistoryUrl: (url: string) => void;
}

interface HistorySectionProps {
  title: string;
  entries: BrowserHistoryListEntry[];
  onOpenHistoryUrl: (url: string) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function getStartOfToday(): number {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function getHistoryTitle(entry: BrowserHistoryListEntry): string {
  if (entry.title && !isPlaceholderBrowserSessionTitle(entry.title)) {
    return entry.title;
  }
  return getSiteNameFromUrl(entry.url);
}

function buildHistoryGroups(sessions: BrowserSession[]): BrowserHistoryGroups {
  const latestByUrl = new Map<string, BrowserHistoryListEntry>();

  for (const session of sessions) {
    if (session.incognito) continue;

    for (const entry of session.historyEntries ?? []) {
      if (!entry.url) continue;
      const existing = latestByUrl.get(entry.url);
      if (existing && existing.visitedAt >= entry.visitedAt) continue;
      latestByUrl.set(entry.url, {
        ...entry,
        id: `${entry.visitedAt}:${entry.url}`,
      });
    }
  }

  const startOfToday = getStartOfToday();
  const startOfLast7Days = startOfToday - 6 * DAY_MS;
  const startOfLast30Days = startOfToday - 29 * DAY_MS;
  const groups: BrowserHistoryGroups = {
    today: [],
    last7Days: [],
    last30Days: [],
  };

  for (const entry of latestByUrl.values()) {
    if (entry.visitedAt >= startOfToday) {
      groups.today.push(entry);
    } else if (entry.visitedAt >= startOfLast7Days) {
      groups.last7Days.push(entry);
    } else if (entry.visitedAt >= startOfLast30Days) {
      groups.last30Days.push(entry);
    }
  }

  const sortNewestFirst = (
    left: BrowserHistoryListEntry,
    right: BrowserHistoryListEntry
  ) => right.visitedAt - left.visitedAt;

  groups.today.sort(sortNewestFirst);
  groups.last7Days.sort(sortNewestFirst);
  groups.last30Days.sort(sortNewestFirst);

  return groups;
}

const HistoryItem: React.FC<{
  entry: BrowserHistoryListEntry;
  onOpenHistoryUrl: (url: string) => void;
}> = memo(({ entry, onOpenHistoryUrl }) => {
  const title = getHistoryTitle(entry);
  const node: TreeRowNode = {
    id: entry.id,
    name: title,
    path: entry.url,
    type: "file",
    icon: <FaviconIcon url={entry.url} />,
  };

  return (
    <TreeRowBase
      node={node}
      depth={0}
      isSelected={false}
      onClick={() => onOpenHistoryUrl(entry.url)}
    />
  );
});

HistoryItem.displayName = "HistoryItem";

const HistorySection: React.FC<HistorySectionProps> = memo(
  ({ title, entries, onOpenHistoryUrl }) => {
    if (entries.length === 0) return null;

    return (
      <div className="py-1">
        <div className="flex h-7 items-center gap-2 px-3 text-[11px] font-medium tracking-wide text-text-3 uppercase">
          <HugeiconsIcon
            icon={Clock01Icon}
            data-icon="clock"
            size={12}
            strokeWidth={1.75}
          />
          <span>{title}</span>
        </div>
        {entries.map((entry) => (
          <HistoryItem
            key={entry.id}
            entry={entry}
            onOpenHistoryUrl={onOpenHistoryUrl}
          />
        ))}
      </div>
    );
  }
);

HistorySection.displayName = "HistorySection";

export const HistoryTab: React.FC<HistoryTabProps> = memo(
  ({ sessions, onOpenHistoryUrl }) => {
    const { t } = useTranslation();
    const groups = useMemo(() => buildHistoryGroups(sessions), [sessions]);
    const hasHistory =
      groups.today.length > 0 ||
      groups.last7Days.length > 0 ||
      groups.last30Days.length > 0;

    if (!hasHistory) {
      return (
        <Placeholder
          variant="empty"
          title={t("common:placeholders.noBrowsingHistory")}
        />
      );
    }

    return (
      <div className="scrollbar-hide h-full overflow-y-auto">
        <HistorySection
          title={t("common:relativeDate.today")}
          entries={groups.today}
          onOpenHistoryUrl={onOpenHistoryUrl}
        />
        <HistorySection
          title={t("common:relativeDate.last7Days")}
          entries={groups.last7Days}
          onOpenHistoryUrl={onOpenHistoryUrl}
        />
        <HistorySection
          title={t("common:relativeDate.last30Days")}
          entries={groups.last30Days}
          onOpenHistoryUrl={onOpenHistoryUrl}
        />
      </div>
    );
  }
);

HistoryTab.displayName = "HistoryTab";

export default HistoryTab;
