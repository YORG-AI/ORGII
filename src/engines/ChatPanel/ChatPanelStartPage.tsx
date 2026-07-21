import type { TFunction } from "i18next";
import {
  ArrowLeftRight,
  ChevronLeft,
  ChevronRight,
  Download,
  Import,
  KeyRound,
} from "lucide-react";
import React, { useCallback, useState } from "react";

import Button from "@src/components/Button";
import Select, { type SelectOption } from "@src/components/Select";
import TabPill from "@src/components/TabPill";
import { DETAIL_PANEL_TOKENS } from "@src/config/detailPanelTokens";
import ImportSharedSessionDialog from "@src/features/Org2Cloud/ImportSharedSessionDialog";
import { useAvailableAppUpdate } from "@src/scaffold/AppUpdater";
import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelCreateTarget,
} from "@src/store/ui/chatPanelAtom";

type StartPageActionTone = "primary" | "neutral" | "success" | "warning";
type StartPageView = "session" | "work-item" | "more";

interface ChatPanelStartPageAction {
  id: string;
  title: React.ReactNode;
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
  createTarget: ChatPanelCreateTarget;
  createTargetOptions: SelectOption[];
  moreLauncher?: React.ReactNode;
  onAddApiKey: () => void;
  onCreateTarget: (target: ChatPanelCreateTarget) => void;
  onInstallLatestUpdate: () => void;
  onWorkItemAgentModeChange: (enabled: boolean) => void;
  sessionLauncher?: React.ReactNode;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
  workItemAgentMode: boolean;
  workItemLauncher?: React.ReactNode;
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
  createTarget,
  createTargetOptions,
  moreLauncher,
  onAddApiKey,
  onCreateTarget,
  onInstallLatestUpdate,
  onWorkItemAgentModeChange,
  sessionLauncher,
  t,
  workItemAgentMode,
  workItemLauncher,
}: ChatPanelStartPageProps): React.ReactNode {
  const [isImportSessionDialogOpen, setIsImportSessionDialogOpen] =
    useState(false);
  const availableUpdate = useAvailableAppUpdate();
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
  const utilityActions: ChatPanelStartPageAction[] = availableUpdate?.available
    ? [
        {
          id: "install-latest-update",
          title: t("chat.startPage.installLatestUpdate.title"),
          icon: <Download size={16} strokeWidth={1.8} />,
          onClick: onInstallLatestUpdate,
          tone: "warning",
        },
        importSessionAction,
        addApiKeyAction,
      ]
    : [importSessionAction, addApiKeyAction];
  const selectedMoreTarget = createTargetOptions.some(
    (option) => option.value === createTarget
  )
    ? createTarget
    : createTargetOptions[0]?.value;
  const activeView: StartPageView =
    createTarget === CHAT_PANEL_CREATE_TARGET.AGENT_SESSION
      ? "session"
      : createTarget === CHAT_PANEL_CREATE_TARGET.WORK_ITEM
        ? "work-item"
        : "more";
  const handleViewChange = useCallback(
    (key: string) => {
      if (key === "session") {
        onCreateTarget(CHAT_PANEL_CREATE_TARGET.AGENT_SESSION);
        return;
      }
      if (key === "work-item") {
        onCreateTarget(CHAT_PANEL_CREATE_TARGET.WORK_ITEM);
        return;
      }
      if (
        key === "more" &&
        !createTargetOptions.some((option) => option.value === createTarget)
      ) {
        const fallbackTarget = createTargetOptions[0]?.value;
        if (typeof fallbackTarget === "string") {
          onCreateTarget(fallbackTarget as ChatPanelCreateTarget);
        }
      }
    },
    [createTarget, createTargetOptions, onCreateTarget]
  );

  return (
    <div
      className={`flex w-full flex-col overflow-hidden ${className ?? ""}`}
      data-testid="chat-panel-start-page"
    >
      <div
        className="shrink-0 bg-chat-pane"
        data-testid="chat-panel-start-page-tabs"
      >
        <div className="mx-auto flex h-14 w-full max-w-[932px] items-center justify-center gap-3 px-4 pt-1">
          <TabPill
            activeTab={activeView}
            tabs={[
              {
                key: "session",
                label: t("chat.startPage.tabs.session"),
                dataTestId: "chat-panel-start-page-tab-session",
              },
              {
                key: "work-item",
                label: t("chat.startPage.tabs.workItem"),
                dataTestId: "chat-panel-start-page-tab-work-item",
              },
              {
                key: "more",
                label: t("chat.startPage.tabs.more"),
                dataTestId: "chat-panel-start-page-tab-more",
              },
            ]}
            onChange={handleViewChange}
            variant="simple"
            size="large"
            fillWidth={false}
            className="h-10"
          />
          {activeView === "more" || activeView === "work-item" ? (
            <div
              className="flex -translate-y-1 items-center gap-2"
              data-testid="chat-panel-start-page-trailing-control"
            >
              <span
                className="h-5 w-px shrink-0 bg-border-2"
                role="separator"
                aria-hidden
                data-testid="chat-panel-start-page-trailing-separator"
              />
              {activeView === "more" ? (
                <Select
                  value={selectedMoreTarget}
                  options={createTargetOptions}
                  onChange={(value) => {
                    if (!Array.isArray(value)) {
                      onCreateTarget(value as ChatPanelCreateTarget);
                    }
                  }}
                  size="large"
                  variant="ghost"
                  radius="pill"
                  dropdownMinWidth={168}
                  dropdownWidthMode="auto"
                  className="w-auto"
                  selectorClassName="max-w-[240px] !gap-2 !px-1 !text-[16px] !leading-6 [&_.select-suffix]:!ml-0"
                  dataTestId="chat-panel-start-page-create-target-select"
                />
              ) : (
                <Button
                  htmlType="button"
                  variant="tertiary"
                  appearance="ghost"
                  size="large"
                  shape="round"
                  iconPosition="right"
                  icon={
                    <ArrowLeftRight size={12} strokeWidth={1.8} aria-hidden />
                  }
                  onClick={() => onWorkItemAgentModeChange(!workItemAgentMode)}
                  className="!h-9 !px-1 !text-[16px] !font-normal text-text-2"
                  aria-pressed={workItemAgentMode}
                  data-testid="chat-panel-start-page-work-item-mode-toggle"
                >
                  {workItemAgentMode
                    ? t("common:terminology.agent")
                    : t("common:tooltips.manual")}
                </Button>
              )}
            </div>
          ) : null}
        </div>
      </div>
      <div
        className={`min-h-0 flex-1 ${
          activeView === "work-item" || activeView === "more"
            ? "overflow-hidden"
            : "overflow-y-auto"
        }`}
      >
        {activeView === "work-item" ? (
          <div
            className="flex h-full min-h-0 w-full"
            data-testid="chat-panel-start-page-work-item-launcher"
          >
            {workItemLauncher}
          </div>
        ) : activeView === "more" ? (
          <div
            className="flex h-full min-h-0 w-full flex-col overflow-hidden"
            data-testid="chat-panel-start-page-more-launcher"
          >
            <div className="min-h-0 flex-1 overflow-hidden">{moreLauncher}</div>
          </div>
        ) : (
          <div className="flex min-h-full items-center justify-center">
            {sessionLauncher ? (
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
      <div
        className={`shrink-0 px-4 pb-5 pt-2 ${DETAIL_PANEL_TOKENS.headerWidth}`}
        data-testid="chat-panel-start-page-utility-actions"
      >
        <div className="flex w-full flex-col gap-3">
          {activeView === "session" ? (
            <div data-testid="chat-panel-start-page-hints">
              <StartPageHintLine t={t} />
            </div>
          ) : null}
          <div
            className="@container/startactions"
            data-testid="chat-panel-start-page-actions"
          >
            <div className="grid grid-cols-1 gap-3 @[420px]/startactions:grid-cols-2 @[800px]/startactions:grid-cols-3">
              {utilityActions.map((action) => (
                <StartPageActionCard key={action.id} action={action} />
              ))}
            </div>
          </div>
        </div>
      </div>
      {isImportSessionDialogOpen && (
        <ImportSharedSessionDialog
          visible
          onClose={() => setIsImportSessionDialogOpen(false)}
        />
      )}
    </div>
  );
}
