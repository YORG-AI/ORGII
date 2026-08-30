/**
 * Right panel for the consolidated Integrations page.
 *
 * Routing priority per category:
 *   1. Wizard / Browse overlay (add form, skill editor, hub browse, etc.)
 *   2. Detail view (item selected)
 *   3. Default: SettingsTable for the active category
 */
import React, { Suspense, lazy, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import TabPill from "@src/components/TabPill";
import type { ExternalSkillsetsTab } from "@src/config/mainAppPaths";
import {
  DETAIL_PANEL_TOKENS,
  DetailPanelContainer,
  InternalHeader,
  ScrollFadeContainer,
} from "@src/modules/shared/layouts/blocks";

import { ConnectionsCategoryView } from "./Connections/ConnectionsCategoryView";
import { DatabasesCategoryView } from "./Databases/DatabasesCategoryView";
import type {
  DatabaseIntegrationEntry,
  DatabaseProbeResult,
} from "./Databases/types";
import { ExternalSkillsetsCategoryView } from "./ExternalSkillsets/ExternalSkillsetsCategoryView";
import { GitCategoryView } from "./Git/GitCategoryView";
import { HousekeeperCategoryView } from "./Housekeeper/HousekeeperCategoryView";
import { AccountCategoryView } from "./KeyVault/AccountCategoryView";
import MyRolesSection, {
  MY_ROLES_TAB,
  type MyRolesTab,
} from "./KeyVault/MyRoles/MyRolesSection";
import type { useKeyVaultPage } from "./KeyVault/hooks/useKeyVaultPage";
import type { McpDetailState } from "./Mcp/types";
import {
  RoutinesCategoryView,
  type RoutinesDetailState,
} from "./Routines/RoutinesCategoryView";
import { RulesMemoryEvolutionCategoryView } from "./RulesMemoryEvolution/RulesMemoryEvolutionCategoryView";
import type { RulesMemoryEvolutionDetailState } from "./RulesMemoryEvolution/types";
import type { SkillEditorState, SkillsHubDetailState } from "./Skills/types";
import type { CategoryTableContentProps } from "./Tables";
import type { ChannelSlice, DetailMode, IntegrationCategory } from "./types";

const DevToolsCategoryView = lazy(
  () => import("./DevTools/DevToolsCategoryView")
);
const BuiltInToolsCategoryView = lazy(() => import("./ToolsCategoryView"));
const ComputerUseCategoryView = lazy(() => import("./ComputerUseCategoryView"));

// ── Props ──

export interface IntegrationsDetailPanelProps {
  category: IntegrationCategory;
  detailMode: DetailMode;
  selectedIntegrationKind: "git" | "channel" | null;
  selectedGitProvider: string | null;
  onGitConnected?: () => void;
  channel: ChannelSlice;
  accounts: ReturnType<typeof useKeyVaultPage>;

  extensionSelectedId: string | null;
  skillsHub: SkillsHubDetailState;
  skillEditor: SkillEditorState;
  mcp: McpDetailState;
  policies: RulesMemoryEvolutionDetailState;
  routines: RoutinesDetailState;

  databasesState: {
    selectedDatabase: DatabaseIntegrationEntry | null;
    probeResult: DatabaseProbeResult | null;
    probing: boolean;
    addWizardOpen: boolean;
    onProbe: () => void;
    onRemove: () => void;
    onCloseAddWizard: () => void;
  };

  onExitFullPage: () => void;
  onEnterFullPage: () => void;
  onClosePreview: () => void;
  tableProps: CategoryTableContentProps;
  externalSkillsetsTab: ExternalSkillsetsTab;
  onExternalSkillsetsTabChange: (tab: ExternalSkillsetsTab) => void;
}

// ── Router ──

const IntegrationsDetailPanel: React.FC<IntegrationsDetailPanelProps> = ({
  category,
  detailMode,
  selectedIntegrationKind,
  selectedGitProvider,
  onGitConnected,
  channel,
  accounts,
  extensionSelectedId,
  skillsHub,
  skillEditor,
  mcp,
  policies,
  routines,
  databasesState,
  onExitFullPage,
  onEnterFullPage,
  onClosePreview,
  tableProps,
  externalSkillsetsTab,
  onExternalSkillsetsTabChange,
}) => {
  const { t } = useTranslation("settings");
  const [myRolesActiveTab, setMyRolesActiveTab] = useState<MyRolesTab>(
    MY_ROLES_TAB.PRESENCE
  );
  const myRolesTabs = useMemo(
    () => [
      {
        key: MY_ROLES_TAB.PRESENCE,
        label: t("myRoles.tabs.presence"),
      },
      {
        key: MY_ROLES_TAB.PROFILE,
        label: t("myRoles.tabs.profile"),
      },
    ],
    [t]
  );
  const isFullPage = detailMode === "full";
  const onExpand = isFullPage ? undefined : onEnterFullPage;
  switch (category) {
    case "models":
      return (
        <AccountCategoryView
          accounts={accounts}
          tableProps={tableProps}
          fullPage={isFullPage}
          onBack={onExitFullPage}
          onExpand={onExpand}
          onClosePreview={onClosePreview}
        />
      );
    case "myRoles":
      return (
        <DetailPanelContainer>
          <InternalHeader
            noPanelHeader
            contentPadding
            className={DETAIL_PANEL_TOKENS.headerWidth}
            tabs={
              <TabPill
                tabs={myRolesTabs}
                activeTab={myRolesActiveTab}
                onChange={(tab) => setMyRolesActiveTab(tab as MyRolesTab)}
                variant="simple"
                fillWidth={false}
                size="large"
              />
            }
          />
          <ScrollFadeContainer
            className={`scroll-fade-at-top ${DETAIL_PANEL_TOKENS.scrollContentNoTop}`}
          >
            <div className={DETAIL_PANEL_TOKENS.contentWidthWithPaddingNoTop}>
              <MyRolesSection activeTab={myRolesActiveTab} />
            </div>
          </ScrollFadeContainer>
        </DetailPanelContainer>
      );

    case "devtools":
      return (
        <Suspense
          fallback={<Placeholder variant="loading" placement="detail-panel" />}
        >
          <DevToolsCategoryView />
        </Suspense>
      );

    case "tools":
      return (
        <Suspense
          fallback={<Placeholder variant="loading" placement="detail-panel" />}
        >
          <BuiltInToolsCategoryView />
        </Suspense>
      );

    case "computerUse":
      return (
        <Suspense
          fallback={<Placeholder variant="loading" placement="detail-panel" />}
        >
          <ComputerUseCategoryView />
        </Suspense>
      );

    case "externalSkillsets":
      return (
        <ExternalSkillsetsCategoryView
          activeTab={externalSkillsetsTab}
          onTabChange={onExternalSkillsetsTabChange}
          selectedExtensionId={extensionSelectedId}
          mcp={mcp}
          skillsHub={skillsHub}
          skillEditor={skillEditor}
          tableProps={tableProps}
          fullPage={isFullPage}
          onBack={onExitFullPage}
          onEnterFullPage={onEnterFullPage}
          onClosePreview={onClosePreview}
        />
      );

    case "databases":
      return (
        <DatabasesCategoryView
          selectedDatabase={databasesState.selectedDatabase}
          probeResult={databasesState.probeResult}
          probing={databasesState.probing}
          onProbe={databasesState.onProbe}
          onRemove={databasesState.onRemove}
          addWizardOpen={databasesState.addWizardOpen}
          onCloseAddWizard={databasesState.onCloseAddWizard}
          tableProps={tableProps}
          fullPage={isFullPage}
          onBack={onExitFullPage}
          onExpand={onExpand}
          onClosePreview={onClosePreview}
        />
      );

    case "housekeeper":
      return <HousekeeperCategoryView />;

    case "connections":
      return (
        <ConnectionsCategoryView
          selectedIntegrationKind={selectedIntegrationKind}
          selectedGitProvider={selectedGitProvider}
          onGitConnected={onGitConnected}
          channel={channel}
          tableProps={tableProps}
          fullPage={isFullPage}
          onBack={onExitFullPage}
          onExpand={onExpand}
          onClosePreview={onClosePreview}
        />
      );

    case "git":
      return (
        <GitCategoryView
          selectedProvider={selectedGitProvider}
          onSelectProvider={tableProps.onSelectGitProvider}
        />
      );

    case "rulesMemoryEvolution":
      return (
        <RulesMemoryEvolutionCategoryView
          policies={policies}
          tableProps={tableProps}
          fullPage={isFullPage}
          onBack={onExitFullPage}
          onExpand={onExpand}
        />
      );

    case "routines":
      return (
        <RoutinesCategoryView
          routines={routines}
          tableProps={tableProps}
          fullPage={isFullPage}
          onBack={onExitFullPage}
          onExpand={onExpand}
        />
      );
  }
};

export default IntegrationsDetailPanel;
