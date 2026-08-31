/**
 * Language Servers Page
 *
 * Embedded list of LSP language servers + the global "auto-install" switch.
 * Selecting a row toggles the table's inline expanded card; install,
 * uninstall, and workspace-enable actions live inside that card.
 */
import { useAtomValue } from "jotai";
import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Switch from "@src/components/Switch";
import { createLogger } from "@src/hooks/logger";
import {
  useLanguageServers,
  useLspGlobalConfig,
} from "@src/modules/MainApp/Integrations/hooks/lsp";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { TerminalService } from "@src/services/terminal/TerminalService";
import { activeWorkspaceRootPathAtom } from "@src/store/workspace";

import type { LspHandlers } from "./Table/LanguageServerInlineExpandedCard";
import LanguageServersTable from "./Table/LanguageServersTable";

const log = createLogger("LanguageServersPage");

const LanguageServersPage: React.FC = () => {
  const { t } = useTranslation("settings");
  const workspacePath = useAtomValue(activeWorkspaceRootPathAtom) || null;
  const executeInTerminal = TerminalService.execute;

  const {
    servers,
    isLoading,
    getActionState,
    handleInstall,
    handleUninstall,
    handleWorkspaceToggle,
    isServerEnabled,
  } = useLanguageServers({ workspacePath, executeInTerminal });

  const {
    config,
    isLoading: configLoading,
    setAutoInstall,
  } = useLspGlobalConfig();

  const lspHandlers: LspHandlers = useMemo(
    () => ({
      handleInstall,
      handleUninstall,
      handleWorkspaceToggle,
      getActionState,
      isServerEnabled,
    }),
    [
      getActionState,
      handleInstall,
      handleUninstall,
      handleWorkspaceToggle,
      isServerEnabled,
    ]
  );

  const handleAutoInstallToggle = async (checked: boolean) => {
    try {
      await setAutoInstall(checked);
    } catch (error) {
      log.error("Failed to toggle auto-install:", error);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <SectionContainer>
        <SectionRow
          label={t("languageServersPage.autoInstall")}
          description={t("languageServersPage.autoInstallDesc")}
        >
          <Switch
            checked={config.autoInstall}
            onCheckedChange={handleAutoInstallToggle}
            disabled={configLoading}
          />
        </SectionRow>
      </SectionContainer>
      <LanguageServersTable
        servers={servers}
        loading={isLoading}
        workspacePath={workspacePath}
        lspHandlers={lspHandlers}
      />
    </div>
  );
};

export default LanguageServersPage;
