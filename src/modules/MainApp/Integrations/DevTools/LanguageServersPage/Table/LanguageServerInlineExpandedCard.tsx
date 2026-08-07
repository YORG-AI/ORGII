import { ExternalLink } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { requiredBinaryFromHint } from "@src/config/prerequisites";
import { usePrerequisiteCheck } from "@src/hooks/dependencies/usePrerequisiteCheck";
import { Placeholder } from "@src/modules/shared/layouts/blocks";
import { InfoRow } from "@src/modules/shared/layouts/blocks/InfoRow";
import { openExternalLink } from "@src/util/platform/ipcRenderer";

import {
  InlineCardBody,
  InlineCardColumnStack,
  InlineCardFooter,
  InlineCardShell,
  InlineCardSplit,
  InlineCardTabs,
  InlineSplitNavRow,
} from "../../../KeyVault/shared/InlineCardPrimitives";
import { InstallScriptPanel } from "../../../shared/InstallScriptPanel";
import { LspLogDrawer } from "../components/LspLogDrawer";
import {
  LSP_DOCS_URL,
  deriveUninstallHint,
  detectPackageManager,
} from "../config";
import type { ActionState, LanguageServerInfo } from "../types";

export const LSP_INLINE_TAB = {
  STATUS: "status",
  INSTALL: "install",
  LOGS: "logs",
} as const;

export type LspInlineTab = (typeof LSP_INLINE_TAB)[keyof typeof LSP_INLINE_TAB];

const LSP_INSTALL_MODE = {
  INSTALL: "install",
  UNINSTALL: "uninstall",
} as const;

type LspInstallMode = (typeof LSP_INSTALL_MODE)[keyof typeof LSP_INSTALL_MODE];

export interface LspHandlers {
  handleInstall: (language: string) => void;
  handleUninstall: (language: string) => void;
  handleWorkspaceToggle: (language: string, enabled: boolean) => void;
  getActionState: (language: string) => ActionState;
  isServerEnabled: (language: string) => boolean;
}

interface LanguageServerInlineExpandedCardProps {
  server: LanguageServerInfo;
  activeTab: LspInlineTab;
  onActiveTabChange: (tab: LspInlineTab) => void;
  lspHandlers?: LspHandlers;
}

const LanguageServerInlineExpandedCard: React.FC<
  LanguageServerInlineExpandedCardProps
> = ({ server, activeTab, onActiveTabChange, lspHandlers }) => {
  const { t } = useTranslation("integrations");
  const { t: tSettings } = useTranslation("settings");

  const lang = server.language.toLowerCase();
  const docsUrl = LSP_DOCS_URL[lang];
  const actionState = lspHandlers?.getActionState(server.language);
  const isBusy =
    actionState?.status === "installing" ||
    actionState?.status === "uninstalling";

  const installHint = server.installHint;
  const uninstallHint = useMemo(
    () => (installHint ? deriveUninstallHint(installHint) : undefined),
    [installHint]
  );
  const methodLabel = useMemo(
    () => (installHint ? detectPackageManager(installHint) : ""),
    [installHint]
  );

  const hasInstallScript = !!installHint;
  const hasUninstallScript = !!(uninstallHint && server.uninstallSupported);
  const showInstallTab = hasInstallScript || hasUninstallScript;
  const showLogsTab = server.installed;

  const [installMode, setInstallMode] = useState<LspInstallMode>(
    server.installed && hasUninstallScript
      ? LSP_INSTALL_MODE.UNINSTALL
      : LSP_INSTALL_MODE.INSTALL
  );

  const tabs = useMemo(
    () => [
      {
        key: LSP_INLINE_TAB.STATUS,
        label: t("keyVault.inlineCard.tabStatus"),
      },
      {
        key: LSP_INLINE_TAB.INSTALL,
        label: t("cliPreview.clientSection"),
        disabled: !showInstallTab,
      },
      {
        key: LSP_INLINE_TAB.LOGS,
        label: t("lspPreview.logSection"),
        disabled: !showLogsTab,
      },
    ],
    [showInstallTab, showLogsTab, t]
  );

  const effectiveActiveTab = useMemo(() => {
    const match = tabs.find((tab) => tab.key === activeTab && !tab.disabled);
    return match?.key ?? LSP_INLINE_TAB.STATUS;
  }, [activeTab, tabs]);

  const selectedInstallCommand =
    installMode === LSP_INSTALL_MODE.INSTALL ? installHint : uninstallHint;

  const requiredBinary = useMemo(
    () =>
      selectedInstallCommand
        ? requiredBinaryFromHint(selectedInstallCommand)
        : null,
    [selectedInstallCommand]
  );
  const { available: prereqAvailable } = usePrerequisiteCheck(requiredBinary);

  const statusContent = (
    <InlineCardSplit
      equalColumns
      left={
        <InlineCardColumnStack>
          <InfoRow label={t("lspPreview.status")}>
            <span
              className={`text-[12px] font-medium ${
                server.installed ? "text-success-6" : "text-text-3"
              }`}
            >
              {server.installed
                ? tSettings("languageServersPage.installed")
                : tSettings("cliConfig.statusNotInstalled")}
            </span>
          </InfoRow>
          <InfoRow label={t("lspPreview.language")}>
            <span className="text-[12px] font-medium text-text-1">
              {server.displayName}
            </span>
          </InfoRow>
          <InfoRow label={t("lspPreview.command")}>
            <span className="text-[12px] text-text-2">{server.command}</span>
          </InfoRow>
        </InlineCardColumnStack>
      }
      right={
        <InlineCardColumnStack>
          {methodLabel ? (
            <InfoRow label={t("cliPreview.installedVia")}>
              <span className="text-[12px] font-medium text-text-1">
                {methodLabel}
              </span>
            </InfoRow>
          ) : null}
        </InlineCardColumnStack>
      }
    />
  );

  const installContent = showInstallTab ? (
    selectedInstallCommand ? (
      <InlineCardSplit
        left={
          <>
            <InlineSplitNavRow
              label={tSettings("cliConfig.install")}
              selected={installMode === LSP_INSTALL_MODE.INSTALL}
              disabled={!hasInstallScript}
              onSelect={() => setInstallMode(LSP_INSTALL_MODE.INSTALL)}
            />
            <InlineSplitNavRow
              label={t("common:actions.uninstall")}
              selected={installMode === LSP_INSTALL_MODE.UNINSTALL}
              disabled={!hasUninstallScript}
              onSelect={() => setInstallMode(LSP_INSTALL_MODE.UNINSTALL)}
            />
          </>
        }
        right={
          <InstallScriptPanel
            mode={installMode}
            command={selectedInstallCommand}
            onAction={
              lspHandlers
                ? () =>
                    installMode === LSP_INSTALL_MODE.INSTALL
                      ? lspHandlers.handleInstall(server.language)
                      : lspHandlers.handleUninstall(server.language)
                : undefined
            }
            actionLoading={isBusy && actionState?.action === installMode}
            actionDisabled={isBusy}
            prerequisiteBinary={requiredBinary}
            prerequisiteAvailable={prereqAvailable}
          />
        }
      />
    ) : (
      <Placeholder
        variant="empty"
        title={
          installMode === LSP_INSTALL_MODE.INSTALL
            ? t("cliPreview.noInstallScript")
            : t("cliPreview.noUninstallScript")
        }
      />
    )
  ) : (
    <Placeholder variant="empty" title={t("cliPreview.noInstallScript")} />
  );

  const logsContent = showLogsTab ? (
    <LspLogDrawer language={server.language} enabled />
  ) : null;

  const tabContent = (() => {
    switch (effectiveActiveTab) {
      case LSP_INLINE_TAB.INSTALL:
        return installContent;
      case LSP_INLINE_TAB.LOGS:
        return logsContent;
      case LSP_INLINE_TAB.STATUS:
      default:
        return statusContent;
    }
  })();

  return (
    <InlineCardShell>
      <InlineCardTabs
        tabs={tabs}
        activeTab={effectiveActiveTab}
        onChange={onActiveTabChange}
      />
      <InlineCardBody>{tabContent}</InlineCardBody>
      {effectiveActiveTab !== LSP_INLINE_TAB.INSTALL && docsUrl ? (
        <InlineCardFooter>
          <Button
            variant="secondary"
            size="small"
            icon={<ExternalLink size={14} />}
            iconPosition="right"
            onClick={() => openExternalLink(docsUrl)}
          >
            {t("cliPreview.docs")}
          </Button>
        </InlineCardFooter>
      ) : null}
    </InlineCardShell>
  );
};

export default LanguageServerInlineExpandedCard;
