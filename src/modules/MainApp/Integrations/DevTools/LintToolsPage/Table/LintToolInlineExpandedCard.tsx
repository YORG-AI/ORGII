import { SquareArrowOutUpRight } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import { requiredBinaryFromHint } from "@src/config/prerequisites";
import { usePrerequisiteCheck } from "@src/modules/MainApp/Integrations/hooks/usePrerequisiteCheck";
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
import type {
  ActionState,
  LintToolInfo,
} from "../../LanguageServersPage/types";
import {
  LINT_TOOL_DOCS_URL,
  deriveUninstallHint,
  detectPackageManager,
} from "../config";

export const LINT_INLINE_TAB = {
  STATUS: "status",
  INSTALL: "install",
} as const;

export type LintInlineTab =
  (typeof LINT_INLINE_TAB)[keyof typeof LINT_INLINE_TAB];

const LINT_INSTALL_MODE = {
  INSTALL: "install",
  UNINSTALL: "uninstall",
} as const;

type LintInstallMode =
  (typeof LINT_INSTALL_MODE)[keyof typeof LINT_INSTALL_MODE];

export interface LintHandlers {
  handleInstall: (toolId: string) => void;
  handleUninstall: (toolId: string) => void;
  handleWorkspaceToggle: (toolId: string, enabled: boolean) => void;
  getActionState: (toolId: string) => ActionState;
  isToolEnabled: (toolId: string) => boolean;
}

interface LintToolInlineExpandedCardProps {
  tool: LintToolInfo;
  activeTab: LintInlineTab;
  onActiveTabChange: (tab: LintInlineTab) => void;
  lintHandlers?: LintHandlers;
}

const LintToolInlineExpandedCard: React.FC<LintToolInlineExpandedCardProps> = ({
  tool,
  activeTab,
  onActiveTabChange,
  lintHandlers,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tSettings } = useTranslation("settings");

  const docsUrl = LINT_TOOL_DOCS_URL[tool.id];
  const actionState = lintHandlers?.getActionState(tool.id);
  const isBusy =
    actionState?.status === "installing" ||
    actionState?.status === "uninstalling";

  const installHint = tool.installHint;
  const uninstallHint = useMemo(
    () => (installHint ? deriveUninstallHint(installHint) : undefined),
    [installHint]
  );
  const methodLabel = useMemo(
    () => (installHint ? detectPackageManager(installHint) : ""),
    [installHint]
  );

  const hasInstallScript = !!installHint;
  const hasUninstallScript = !!(uninstallHint && tool.uninstallSupported);
  const showInstallTab = hasInstallScript || hasUninstallScript;

  const [installMode, setInstallMode] = useState<LintInstallMode>(
    tool.installed && hasUninstallScript
      ? LINT_INSTALL_MODE.UNINSTALL
      : LINT_INSTALL_MODE.INSTALL
  );

  const tabs = useMemo(
    () => [
      {
        key: LINT_INLINE_TAB.STATUS,
        label: t("keyVault.inlineCard.tabStatus"),
      },
      {
        key: LINT_INLINE_TAB.INSTALL,
        label: t("cliPreview.clientSection"),
        disabled: !showInstallTab,
      },
    ],
    [showInstallTab, t]
  );

  const effectiveActiveTab = useMemo(() => {
    const match = tabs.find((tab) => tab.key === activeTab && !tab.disabled);
    return match?.key ?? LINT_INLINE_TAB.STATUS;
  }, [activeTab, tabs]);

  const selectedInstallCommand =
    installMode === LINT_INSTALL_MODE.INSTALL ? installHint : uninstallHint;

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
                tool.installed ? "text-success-6" : "text-text-3"
              }`}
            >
              {tool.installed
                ? tSettings("languageServersPage.installed")
                : tSettings("cliConfig.statusNotInstalled")}
            </span>
          </InfoRow>
          <InfoRow label={t("lintPreview.languages")}>
            <span className="min-w-0 truncate text-[12px] text-text-2">
              {tool.languages.join(", ")}
            </span>
          </InfoRow>
          {tool.installed && tool.version ? (
            <InfoRow label={t("lintPreview.version")}>
              <span className="text-[12px] font-medium text-text-1">
                {tool.version}
              </span>
            </InfoRow>
          ) : null}
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
              selected={installMode === LINT_INSTALL_MODE.INSTALL}
              disabled={!hasInstallScript}
              onSelect={() => setInstallMode(LINT_INSTALL_MODE.INSTALL)}
            />
            <InlineSplitNavRow
              label={t("common:actions.uninstall")}
              selected={installMode === LINT_INSTALL_MODE.UNINSTALL}
              disabled={!hasUninstallScript}
              onSelect={() => setInstallMode(LINT_INSTALL_MODE.UNINSTALL)}
            />
          </>
        }
        right={
          <InstallScriptPanel
            mode={installMode}
            command={selectedInstallCommand}
            onAction={
              lintHandlers
                ? () =>
                    installMode === LINT_INSTALL_MODE.INSTALL
                      ? lintHandlers.handleInstall(tool.id)
                      : lintHandlers.handleUninstall(tool.id)
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
          installMode === LINT_INSTALL_MODE.INSTALL
            ? t("cliPreview.noInstallScript")
            : t("cliPreview.noUninstallScript")
        }
      />
    )
  ) : (
    <Placeholder variant="empty" title={t("cliPreview.noInstallScript")} />
  );

  const tabContent =
    effectiveActiveTab === LINT_INLINE_TAB.INSTALL
      ? installContent
      : statusContent;

  return (
    <InlineCardShell>
      <InlineCardTabs
        tabs={tabs}
        activeTab={effectiveActiveTab}
        onChange={onActiveTabChange}
      />
      <InlineCardBody>{tabContent}</InlineCardBody>
      {effectiveActiveTab !== LINT_INLINE_TAB.INSTALL && docsUrl ? (
        <InlineCardFooter>
          <Button
            variant="secondary"
            size="small"
            icon={<SquareArrowOutUpRight size={14} />}
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

export default LintToolInlineExpandedCard;
