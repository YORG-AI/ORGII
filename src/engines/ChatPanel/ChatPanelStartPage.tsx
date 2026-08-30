import type { TFunction } from "i18next";
import React, { useCallback, useState } from "react";

import SegmentedTextPill from "@src/components/SegmentedTextPill";
import Select, { type SelectOption } from "@src/components/Select";
import TabPill from "@src/components/TabPill";
import { CHAT_PANEL_WIDTH_TOKENS } from "@src/config/detailPanelTokens";
import ImportSharedSessionDialog from "@src/features/Org2Cloud/ImportSharedSessionDialog";
import {
  type LaunchpadAction,
  LaunchpadActionCard,
} from "@src/features/SessionCreator/components/LaunchpadActionGrid";
import {
  Download01Icon,
  GaugeIcon,
  HugeiconsIcon,
  ImportIcon,
  Key02Icon,
} from "@src/icons";
import { CreatorContentLayout } from "@src/modules/shared/layouts/blocks";
import { useAvailableAppUpdate } from "@src/scaffold/AppUpdater";
import {
  CHAT_PANEL_CREATE_TARGET,
  type ChatPanelCreateTarget,
} from "@src/store/ui/chatPanelAtom";

type StartPageView = "session" | "work-item" | "more";

interface ChatPanelStartPageProps {
  className?: string;
  createTarget: ChatPanelCreateTarget;
  createTargetOptions: SelectOption[];
  moreLauncher?: (
    manualMiddleContent: React.ReactNode,
    creatorModeControl?: React.ReactNode
  ) => React.ReactNode;
  onAddApiKey: () => void;
  onCreateTarget: (target: ChatPanelCreateTarget) => void;
  onInstallLatestUpdate: () => void;
  onShowRuntime: () => void;
  onProjectAgentModeChange: (enabled: boolean) => void;
  onWorkItemAgentModeChange: (enabled: boolean) => void;
  projectAgentMode: boolean;
  sessionLauncher?: (heroFooterSlot: React.ReactNode) => React.ReactNode;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
  workItemAgentMode: boolean;
  workItemLauncher?: (
    manualMiddleContent: React.ReactNode,
    creatorModeControl: React.ReactNode
  ) => React.ReactNode;
}

interface StartPageCreatorModeToggleProps {
  agentMode: boolean;
  dataTestId: string;
  onChange: (enabled: boolean) => void;
  t: TFunction<["sessions", "common", "projects", "navigation"]>;
}

function StartPageCreatorModeToggle({
  agentMode,
  dataTestId,
  onChange,
  t,
}: StartPageCreatorModeToggleProps): React.ReactNode {
  return (
    <SegmentedTextPill
      ariaLabel={`${t("common:terminology.agent")} / ${t(
        "common:tooltips.manual"
      )}`}
      dataTestId={dataTestId}
      value={agentMode ? "agent" : "manual"}
      options={[
        { value: "agent", label: t("common:terminology.agent") },
        { value: "manual", label: t("common:tooltips.manual") },
      ]}
      onChange={(value) => onChange(value === "agent")}
    />
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
  onShowRuntime,
  onProjectAgentModeChange,
  onWorkItemAgentModeChange,
  projectAgentMode,
  sessionLauncher,
  t,
  workItemAgentMode,
  workItemLauncher,
}: ChatPanelStartPageProps): React.ReactNode {
  const [isImportSessionDialogOpen, setIsImportSessionDialogOpen] =
    useState(false);
  const availableUpdate = useAvailableAppUpdate();
  const importSessionAction: LaunchpadAction = {
    id: "import-session",
    title: t("navigation:cloud.share.importEntry"),
    icon: (
      <HugeiconsIcon
        icon={ImportIcon}
        data-icon="import"
        size={16}
        strokeWidth={1.8}
      />
    ),
    onClick: () => setIsImportSessionDialogOpen(true),
    tone: "neutral",
  };
  const addApiKeyAction: LaunchpadAction = {
    id: "add-api-key",
    title: t("chat.startPage.addApiKey.title"),
    icon: (
      <HugeiconsIcon
        icon={Key02Icon}
        data-icon="key-round"
        size={16}
        strokeWidth={1.8}
      />
    ),
    onClick: onAddApiKey,
    tone: "neutral",
  };
  const showRuntimeAction: LaunchpadAction = {
    id: "show-runtime",
    title: t("chat.startPage.showRuntime.title"),
    icon: (
      <HugeiconsIcon
        icon={GaugeIcon}
        data-icon="gauge"
        size={16}
        strokeWidth={1.8}
      />
    ),
    onClick: onShowRuntime,
    tone: "neutral",
  };
  const utilityActions: LaunchpadAction[] = availableUpdate?.available
    ? [
        {
          id: "install-latest-update",
          title: t("chat.startPage.installLatestUpdate.title"),
          icon: (
            <HugeiconsIcon
              icon={Download01Icon}
              data-icon="download"
              size={16}
              strokeWidth={1.8}
            />
          ),
          onClick: onInstallLatestUpdate,
          tone: "warning",
        },
        importSessionAction,
        addApiKeyAction,
        showRuntimeAction,
      ]
    : [importSessionAction, addApiKeyAction, showRuntimeAction];
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
  const suggestionCards = utilityActions.map((action) => (
    <LaunchpadActionCard key={action.id} action={action} presentation="card" />
  ));
  const manualMiddleContent = (
    <div
      className="flex w-full flex-col items-center justify-center gap-4"
      data-testid="chat-panel-start-page-manual-middle-content"
    >
      <h1 className="text-center text-[18px] font-normal leading-relaxed tracking-tight text-text-1 sm:text-[20px]">
        {t(
          activeView === "work-item"
            ? "creator.manualPlanLaunchpadQuestion"
            : "creator.manualLaunchpadQuestion"
        )}
      </h1>
    </div>
  );
  const workItemModeControl = (
    <StartPageCreatorModeToggle
      agentMode={workItemAgentMode}
      dataTestId="chat-panel-start-page-work-item-mode-toggle"
      onChange={onWorkItemAgentModeChange}
      t={t}
    />
  );
  const projectModeControl = (
    <StartPageCreatorModeToggle
      agentMode={projectAgentMode}
      dataTestId="chat-panel-start-page-project-mode-toggle"
      onChange={onProjectAgentModeChange}
      t={t}
    />
  );
  const sessionLauncherContent = sessionLauncher?.(suggestionCards);
  const workItemLauncherContent = workItemLauncher?.(
    manualMiddleContent,
    workItemModeControl
  );
  const moreLauncherContent = moreLauncher?.(
    manualMiddleContent,
    createTarget === CHAT_PANEL_CREATE_TARGET.PROJECT
      ? projectModeControl
      : undefined
  );
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
        <div
          className={`${CHAT_PANEL_WIDTH_TOKENS.headerWidth} flex h-14 items-center justify-center gap-3 px-4 pt-1`}
        >
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
          {activeView === "more" ? (
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
              <Select
                value={selectedMoreTarget}
                options={createTargetOptions}
                onChange={(value) => {
                  if (!Array.isArray(value)) {
                    onCreateTarget(value as ChatPanelCreateTarget);
                  }
                }}
                size="large"
                appearance="bare"
                radius="pill"
                dropdownMinWidth={168}
                dropdownWidthMode="auto"
                className="select-title-row w-auto"
                selectorClassName="max-w-[240px] !gap-2 !px-1 !text-[16px] !leading-6 [&_.select-suffix]:!ml-0"
                dataTestId="chat-panel-start-page-create-target-select"
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeView === "work-item" ? (
          <div
            className="flex h-full min-h-0 w-full"
            data-testid="chat-panel-start-page-work-item-launcher"
          >
            {workItemLauncherContent}
          </div>
        ) : activeView === "more" ? (
          <div
            className="flex h-full min-h-0 w-full flex-col overflow-hidden"
            data-testid="chat-panel-start-page-more-launcher"
          >
            {moreLauncherContent}
          </div>
        ) : (
          <CreatorContentLayout
            placement="fill"
            contentDataTestId="chat-panel-start-page-session-content"
          >
            {sessionLauncherContent ? (
              <div
                className="h-full w-full"
                data-testid="chat-panel-start-page-session-launcher"
              >
                {sessionLauncherContent}
              </div>
            ) : null}
          </CreatorContentLayout>
        )}
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
