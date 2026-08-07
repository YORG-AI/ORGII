import type { TFunction } from "i18next";
import { useAtom } from "jotai";
import {
  BriefcaseBusiness,
  ChevronLeft,
  ChevronRight,
  Download,
  Import,
  KeyRound,
} from "lucide-react";
import React, { Suspense, useCallback, useMemo, useState } from "react";

import TabPill from "@src/components/TabPill";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import ImportSharedSessionDialog from "@src/features/Org2Cloud/ImportSharedSessionDialog";
import { useAvailableAppUpdate } from "@src/scaffold/AppUpdater";
import {
  CHAT_PANEL_START_PAGE_TAB,
  chatPanelStartPageTabAtom,
} from "@src/store/ui/chatPanelAtom";

const WorkspaceDashboardPanelView = React.lazy(
  () => import("./panels/WorkspaceDashboardPanelView")
);

// The "Runtime" tab reuses the same data-source inventory table shown under
// Kanban → Data source. The panel lives in a shared module so both surfaces
// render the identical component.
const DataSourcePanel = React.lazy(
  () => import("@src/modules/shared/dataSource")
);

type StartPageActionTone = "primary" | "neutral" | "success" | "warning";

interface ChatPanelStartPageAction {
  id: string;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
  tone: StartPageActionTone;
}

const START_PAGE_ACTION_TONE_CLASS: Record<StartPageActionTone, string> = {
  primary:
    "border-primary-6/20 bg-primary-6/5 hover:border-primary-6/30 hover:bg-primary-6/10",
  neutral: "border-border-2 hover:border-border-3",
  success:
    "border-success-6/20 bg-success-6/5 hover:border-success-6/30 hover:bg-success-6/10",
  warning:
    "border-warning-6/20 bg-warning-6/5 hover:border-warning-6/30 hover:bg-warning-6/10",
};

interface StartPageHint {
  id: string;
  textBefore: string;
  command: string;
  textAfter: string;
}

interface ChatPanelStartPageProps {
  className?: string;
  onAddApiKey: () => void;
  onInstallLatestUpdate: () => void;
  onNewWorkItem: () => void;
  sessionLauncher?: React.ReactNode;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}

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
function StartPageActionCard({
  action,
}: {
  action: ChatPanelStartPageAction;
}): React.ReactNode {
  return (
    <button
      type="button"
      className={`group flex w-full items-center gap-2 rounded-full border px-2 py-1.5 text-left transition-colors focus-visible:border-primary-6 focus-visible:outline-none ${START_PAGE_ACTION_TONE_CLASS[action.tone]}`}
      onClick={action.onClick}
      data-testid={`chat-panel-start-page-${action.id}`}
    >
      <span
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-bg-2 text-text-2 transition-colors ${
          action.tone === "warning" ? "group-hover:bg-fill-3" : ""
        }`}
      >
        {action.icon}
      </span>
      <span className="block min-w-0 flex-1 truncate text-[13px] font-semibold text-text-1">
        {action.title}
      </span>
      <ChevronRight
        size={14}
        strokeWidth={1.8}
        className="shrink-0 text-text-3 opacity-0 transition-opacity group-hover:opacity-100"
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
  onInstallLatestUpdate,
  onNewWorkItem,
  sessionLauncher,
  t,
}: ChatPanelStartPageProps): React.ReactNode {
  const [activeTab, setActiveTab] = useAtom(chatPanelStartPageTabAtom);
  const [isImportSessionDialogOpen, setIsImportSessionDialogOpen] =
    useState(false);
  const availableUpdate = useAvailableAppUpdate();
  const tabs = useMemo(
    () => [
      {
        key: CHAT_PANEL_START_PAGE_TAB.WORK,
        label: t("chat.startPage.tabs.work"),
        dataTestId: "chat-panel-start-page-tab-work",
      },
      {
        key: CHAT_PANEL_START_PAGE_TAB.MANAGE,
        label: t("chat.startPage.tabs.manage"),
        dataTestId: "chat-panel-start-page-tab-manage",
      },
      {
        key: CHAT_PANEL_START_PAGE_TAB.RUNTIME,
        label: t("chat.startPage.tabs.runtime"),
        dataTestId: "chat-panel-start-page-tab-runtime",
      },
    ],
    [t]
  );

  const handleTabChange = useCallback(
    (key: string) => {
      setActiveTab(key as typeof activeTab);
    },
    [setActiveTab]
  );

  const newWorkItemAction: ChatPanelStartPageAction = {
    id: "new-work-item",
    title: t("chat.startPage.newWorkItem.title"),
    icon: <BriefcaseBusiness size={16} strokeWidth={1.8} />,
    onClick: onNewWorkItem,
    tone: "neutral",
  };
  const importSessionAction: ChatPanelStartPageAction = {
    id: "import-session",
    title: t("navigation:cloud.share.importEntry"),
    icon: <Import size={16} strokeWidth={1.8} />,
    onClick: () => setIsImportSessionDialogOpen(true),
    tone: "neutral",
  };
  const addApiKeyAction: ChatPanelStartPageAction = {
    id: "add-api-key",
    title: t("chat.startPage.addApiKey.title"),
    icon: <KeyRound size={16} strokeWidth={1.8} />,
    onClick: onAddApiKey,
    tone: "neutral",
  };
  const workActions: ChatPanelStartPageAction[] = availableUpdate?.available
    ? [
        {
          id: "install-latest-update",
          title: t("chat.startPage.installLatestUpdate.title"),
          icon: <Download size={16} strokeWidth={1.8} />,
          onClick: onInstallLatestUpdate,
          tone: "warning",
        },
        importSessionAction,
        newWorkItemAction,
        addApiKeyAction,
      ]
    : [importSessionAction, newWorkItemAction, addApiKeyAction];
  const manageTabActive = activeTab === CHAT_PANEL_START_PAGE_TAB.MANAGE;
  const runtimeTabActive = activeTab === CHAT_PANEL_START_PAGE_TAB.RUNTIME;
  // The Manage dashboard and the Runtime data-source panel both scroll
  // internally (they fill their container), so the body wrapper must not add
  // its own scrollbar for those tabs.
  const bodyOverflowClass =
    manageTabActive || runtimeTabActive ? "overflow-hidden" : "overflow-y-auto";

  return (
    <div
      className={`flex w-full flex-col overflow-hidden ${className ?? ""}`}
      data-testid="chat-panel-start-page"
    >
      <div
        className={`flex shrink-0 justify-center px-4 pb-2 pt-4 ${DETAIL_PANEL_TOKENS.headerWidth}`}
        data-testid="chat-panel-start-page-tabs"
      >
        <TabPill
          variant="simple"
          size="large"
          fillWidth={false}
          tabs={tabs}
          activeTab={activeTab}
          onChange={handleTabChange}
        />
      </div>
      <div className={`min-h-0 flex-1 ${bodyOverflowClass}`}>
        {manageTabActive ? (
          <Suspense fallback={null}>
            <WorkspaceDashboardPanelView />
          </Suspense>
        ) : runtimeTabActive ? (
          <div
            className="relative h-full w-full"
            data-testid="chat-panel-start-page-runtime"
          >
            <Suspense fallback={null}>
              <DataSourcePanel />
            </Suspense>
          </div>
        ) : (
          <div className="flex min-h-full items-center justify-center">
            {activeTab === CHAT_PANEL_START_PAGE_TAB.WORK && sessionLauncher ? (
              <div
                className="w-full"
                data-testid="chat-panel-start-page-session-launcher"
              >
                {sessionLauncher}
              </div>
            ) : null}
          </div>
        )}
      </div>
      {activeTab === CHAT_PANEL_START_PAGE_TAB.WORK ? (
        <div
          className={`shrink-0 px-4 pb-5 pt-2 ${DETAIL_PANEL_TOKENS.headerWidth}`}
          data-testid="chat-panel-start-page-actions"
        >
          <div className="flex w-full flex-col gap-3">
            <StartPageHintLine t={t} />
            <div className="@container/startactions">
              <div className="grid grid-cols-1 gap-3 @[420px]/startactions:grid-cols-2 @[800px]/startactions:grid-cols-4">
                {workActions.map((action) => (
                  <StartPageActionCard key={action.id} action={action} />
                ))}
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {isImportSessionDialogOpen && (
        <ImportSharedSessionDialog
          visible
          onClose={() => setIsImportSessionDialogOpen(false)}
        />
      )}
    </div>
  );
}
