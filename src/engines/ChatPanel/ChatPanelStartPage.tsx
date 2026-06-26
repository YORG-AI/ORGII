import type { TFunction } from "i18next";
import { useAtomValue } from "jotai";
import {
  BriefcaseBusiness,
  ChevronLeft,
  ChevronRight,
  FolderGit2,
  KeyRound,
  ListTodo,
  MessageSquarePlus,
  Search,
} from "lucide-react";
import React, { useCallback, useEffect, useMemo, useState } from "react";

import { sessionHeatmap } from "@src/api/tauri/session";
import type { SessionHeatmapResponse } from "@src/api/tauri/session";
import TabPill from "@src/components/TabPill";
import { createLogger } from "@src/hooks/logger";
import HeatmapGrid, {
  type HeatmapGridCell,
} from "@src/modules/MainApp/DevRecord/components/HeatmapGrid";
import { chatPanelMaximizedAtom } from "@src/store/ui/chatPanelAtom";

const logger = createLogger("ChatPanelStartPage");

const START_PAGE_TAB = {
  WORK: "work",
  EXPLORE: "explore",
  HEATMAP: "heatmap",
} as const;

type StartPageTabKey = (typeof START_PAGE_TAB)[keyof typeof START_PAGE_TAB];

interface ChatPanelStartPageAction {
  id: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
}

interface StartPageHint {
  id: string;
  textBefore: string;
  command: string;
  textAfter: string;
}

interface ChatPanelStartPageProps {
  className?: string;
  onAddApiKey: () => void;
  onExploreRepos: () => void;
  onManageIssues: () => void;
  onNewSession: () => void;
  onNewWorkItem: () => void;
  onSetupRepo: () => void;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}

const HEATMAP_DAY_COUNT = 7;
const HEATMAP_HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const START_PAGE_HINTS: StartPageHint[] = [
  {
    id: "skill",
    textBefore: "chat.startPage.hints.skill.before",
    command: "/",
    textAfter: "chat.startPage.hints.skill.after",
  },
  {
    id: "ask",
    textBefore: "chat.startPage.hints.ask.before",
    command: "/Ask",
    textAfter: "chat.startPage.hints.ask.after",
  },
  {
    id: "plan",
    textBefore: "chat.startPage.hints.plan.before",
    command: "/Plan",
    textAfter: "chat.startPage.hints.plan.after",
  },
  {
    id: "switch",
    textBefore: "chat.startPage.hints.switch.before",
    command: "< >",
    textAfter: "chat.startPage.hints.switch.after",
  },
];
const HEATMAP_X_LABELS = HEATMAP_HOURS.filter((hour) => hour % 4 === 0).map(
  (hour) => ({ index: hour, label: `${hour}:00` })
);
function formatDateForHeatmap(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function getRollingHeatmapRange(): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end);
  start.setDate(end.getDate() - (HEATMAP_DAY_COUNT - 1));
  return {
    startDate: formatDateForHeatmap(start),
    endDate: formatDateForHeatmap(end),
  };
}

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toLocaleString();
}

function StartPageHeatmap({
  t,
}: {
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}): React.ReactNode {
  const [data, setData] = useState<SessionHeatmapResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    sessionHeatmap({
      ...getRollingHeatmapRange(),
      metric: "sessions",
      timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    })
      .then((response) => {
        if (!cancelled) setData(response);
      })
      .catch((err: unknown) => {
        logger.warn("failed to load session heatmap", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const yLabels = useMemo(() => {
    if (!data) return [];
    const labels = new Map<number, string>();
    for (const cell of data.cells) {
      if (!labels.has(cell.day)) labels.set(cell.day, cell.label);
    }
    return Array.from(labels.entries()).map(([index, label]) => ({
      index,
      label,
    }));
  }, [data]);

  const cells = useMemo<HeatmapGridCell[]>(() => {
    if (!data) return [];
    return data.cells.map((cell) => ({
      xIndex: cell.hour,
      yIndex: cell.day,
      count: cell.count,
      label: `${cell.label} ${cell.hour}:00`,
      sessions: cell.sessions,
    }));
  }, [data]);

  if (loading) {
    return (
      <div className="rounded-2xl border border-border-1 bg-chat-container/70 p-4 text-[13px] text-text-2">
        {t("chat.startPage.heatmap.loading")}
      </div>
    );
  }

  if (!data || data.totalSessions === 0) {
    return (
      <div className="rounded-2xl border border-border-1 bg-chat-container/70 p-4 text-[13px] text-text-2">
        {t("chat.startPage.heatmap.empty")}
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-border-1 bg-chat-container/70 p-3 shadow-sm">
      <div className="mb-3 grid grid-cols-3 gap-2 text-center">
        <div className="rounded-xl bg-fill-2 px-2 py-2">
          <div className="text-[11px] text-text-2">
            {t("chat.startPage.heatmap.sessions")}
          </div>
          <div className="text-sm font-semibold tabular-nums text-text-1">
            {formatCompactNumber(data.totalSessions)}
          </div>
        </div>
        <div className="rounded-xl bg-fill-2 px-2 py-2">
          <div className="text-[11px] text-text-2">
            {t("chat.startPage.heatmap.tokens")}
          </div>
          <div className="text-sm font-semibold tabular-nums text-text-1">
            {formatCompactNumber(data.totalTokens)}
          </div>
        </div>
        <div className="rounded-xl bg-fill-2 px-2 py-2">
          <div className="text-[11px] text-text-2">
            {t("chat.startPage.heatmap.cost")}
          </div>
          <div className="text-sm font-semibold tabular-nums text-text-1">
            ${data.totalCost.toFixed(2)}
          </div>
        </div>
      </div>
      <HeatmapGrid
        cells={cells}
        xCount={24}
        yCount={HEATMAP_DAY_COUNT}
        xLabels={HEATMAP_X_LABELS}
        yLabels={yLabels}
        maxCount={Math.max(1, data.maxCount)}
        unit="session"
        yLabelWidth={28}
      />
    </div>
  );
}

function StartPageActionCard({
  action,
}: {
  action: ChatPanelStartPageAction;
}): React.ReactNode {
  return (
    <button
      type="button"
      className="group flex w-full items-center gap-2 rounded-full border border-border-1 bg-chat-container/70 p-2 text-left shadow-sm transition-colors hover:border-border-2 hover:bg-surface-hover"
      onClick={action.onClick}
      data-testid={`chat-panel-start-page-${action.id}`}
    >
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-2 text-text-1 transition-colors group-hover:bg-fill-3">
        {action.icon}
      </span>
      <span className="block min-w-0 flex-1 truncate text-[13px] font-semibold text-text-1">
        {action.title}
      </span>
      <ChevronRight
        size={14}
        strokeWidth={1.8}
        className="shrink-0 text-primary-6 opacity-0 transition-opacity group-hover:opacity-100"
      />
    </button>
  );
}

function StartPageCommandPill({
  command,
}: {
  command: string;
}): React.ReactNode {
  return (
    <span className="mx-0.5 inline-flex rounded-md bg-fill-2 px-1.5 py-0.5 text-[12px] font-medium leading-none text-text-2">
      {command}
    </span>
  );
}

function StartPageHintNavButton({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick: () => void;
}): React.ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      className="inline-flex h-6 w-6 items-center justify-center rounded-md border-0 bg-transparent p-0 text-text-3 opacity-0 transition-colors hover:bg-fill-2 hover:text-text-1 group-focus-within:opacity-100 group-hover:opacity-100"
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function StartPageHintLine({
  t,
}: {
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}): React.ReactNode {
  const [hintIndex, setHintIndex] = useState(0);
  const hint = START_PAGE_HINTS[hintIndex];
  const switchHint = useCallback((direction: "previous" | "next") => {
    setHintIndex((currentIndex) => {
      const delta = direction === "previous" ? -1 : 1;
      return (
        (currentIndex + delta + START_PAGE_HINTS.length) %
        START_PAGE_HINTS.length
      );
    });
  }, []);

  return (
    <div className="group flex items-center justify-center gap-1 px-1 text-center text-[13px] leading-6 text-text-3">
      <StartPageHintNavButton
        label={t("chat.startPage.hints.previous")}
        onClick={() => switchHint("previous")}
      >
        <ChevronLeft size={14} strokeWidth={1.8} />
      </StartPageHintNavButton>
      <p className="min-w-0 flex-1 truncate">
        <span>{t(hint.textBefore)} </span>
        <StartPageCommandPill command={hint.command} />
        <span> {t(hint.textAfter)}</span>
      </p>
      <StartPageHintNavButton
        label={t("chat.startPage.hints.next")}
        onClick={() => switchHint("next")}
      >
        <ChevronRight size={14} strokeWidth={1.8} />
      </StartPageHintNavButton>
    </div>
  );
}

export function ChatPanelStartPage({
  className,
  onAddApiKey,
  onExploreRepos,
  onManageIssues,
  onNewSession,
  onNewWorkItem,
  onSetupRepo,
  t,
}: ChatPanelStartPageProps): React.ReactNode {
  const [activeTab, setActiveTab] = useState<StartPageTabKey>(
    START_PAGE_TAB.WORK
  );
  const isChatPanelMaximized = useAtomValue(chatPanelMaximizedAtom);
  const tabs = useMemo(
    () => [
      { key: START_PAGE_TAB.WORK, label: t("chat.startPage.tabs.work") },
      { key: START_PAGE_TAB.EXPLORE, label: t("chat.startPage.tabs.explore") },
      { key: START_PAGE_TAB.HEATMAP, label: t("chat.startPage.tabs.heatmap") },
    ],
    [t]
  );
  const workActions: ChatPanelStartPageAction[] = [
    {
      id: "new-session",
      title: t("chat.startPage.newSession.title"),
      icon: <MessageSquarePlus size={13} strokeWidth={1.8} />,
      onClick: onNewSession,
    },
    {
      id: "new-work-item",
      title: t("chat.startPage.newWorkItem.title"),
      icon: <BriefcaseBusiness size={13} strokeWidth={1.8} />,
      onClick: onNewWorkItem,
    },
    {
      id: "manage-issues",
      title: t("chat.startPage.manageIssues.title"),
      icon: <ListTodo size={13} strokeWidth={1.8} />,
      onClick: onManageIssues,
    },
    {
      id: "add-api-key",
      title: t("chat.startPage.addApiKey.title"),
      icon: <KeyRound size={13} strokeWidth={1.8} />,
      onClick: onAddApiKey,
    },
  ];
  const exploreActions: ChatPanelStartPageAction[] = [
    {
      id: "setup-repo",
      title: t("chat.startPage.setupRepo.title"),
      icon: <FolderGit2 size={13} strokeWidth={1.8} />,
      onClick: onSetupRepo,
    },
    {
      id: "explore-repos",
      title: t("chat.startPage.exploreRepos.title"),
      icon: <Search size={13} strokeWidth={1.8} />,
      onClick: onExploreRepos,
    },
  ];
  const actions =
    activeTab === START_PAGE_TAB.WORK
      ? workActions
      : activeTab === START_PAGE_TAB.EXPLORE
        ? exploreActions
        : [];
  const contentWidthClass =
    activeTab === START_PAGE_TAB.HEATMAP && isChatPanelMaximized
      ? "max-w-[600px]"
      : "max-w-[400px]";

  return (
    <div
      className={`flex w-full flex-col justify-center overflow-hidden px-3 py-5 ${className ?? ""}`}
      data-testid="chat-panel-start-page"
    >
      <div
        className={`mx-auto flex w-full ${contentWidthClass} -translate-y-5 flex-col gap-3`}
      >
        <div className="flex justify-center px-1">
          <TabPill
            variant="simple"
            size="large"
            fillWidth={false}
            tabs={tabs}
            activeTab={activeTab}
            onChange={(key) => setActiveTab(key as StartPageTabKey)}
          />
        </div>
        {activeTab === START_PAGE_TAB.HEATMAP ? (
          <StartPageHeatmap t={t} />
        ) : (
          <div className="flex flex-col gap-2.5">
            {actions.map((action) => (
              <StartPageActionCard key={action.id} action={action} />
            ))}
          </div>
        )}
        <StartPageHintLine t={t} />
      </div>
    </div>
  );
}
