/**
 * Install / uninstall script section with mode selector on the left and method pills on the right.
 */
import { Copy, Download, Trash2 } from "lucide-react";
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import PrerequisiteAlert from "@src/components/PrerequisiteAlert";
import TabPill from "@src/components/TabPill";
import type { InstallMethod } from "@src/config/cliAgents";
import { INSTALL_METHOD_PREREQUISITES } from "@src/config/prerequisites";
import { usePrerequisiteCheck } from "@src/modules/MainApp/Integrations/hooks/usePrerequisiteCheck";
import { Placeholder } from "@src/modules/shared/layouts/blocks";

import {
  InlineCardColumnStack,
  InlineCardSplit,
  InlineSplitNavRow,
} from "../../shared/InlineCardPrimitives";

const CLI_CLIENT_ACTION_TAB = {
  INSTALL: "install",
  UNINSTALL: "uninstall",
} as const;

type CliClientActionTab =
  (typeof CLI_CLIENT_ACTION_TAB)[keyof typeof CLI_CLIENT_ACTION_TAB];

interface CliClientSectionProps {
  agentName: string;
  installMethods: InstallMethod[];
  uninstallMethods: InstallMethod[];
  defaultMode: CliClientActionTab;
  defaultMethodId?: string;
  onInstall?: () => Promise<void>;
  onUninstall?: () => Promise<void>;
  actionLoading?: boolean;
  actionDisabled?: boolean;
}

export const CliClientSection: React.FC<CliClientSectionProps> = ({
  agentName,
  installMethods,
  uninstallMethods,
  defaultMode,
  defaultMethodId,
  onInstall,
  onUninstall,
  actionLoading,
  actionDisabled,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tSettings } = useTranslation("settings");

  const [activeMode, setActiveMode] = useState<CliClientActionTab>(defaultMode);
  const [selection, setSelection] = useState<{
    agentName: string;
    mode: CliClientActionTab;
    methodId: string;
  } | null>(null);

  const methods =
    activeMode === CLI_CLIENT_ACTION_TAB.INSTALL
      ? installMethods
      : uninstallMethods;

  const resolvedDefault = useMemo(() => {
    if (
      activeMode === CLI_CLIENT_ACTION_TAB.UNINSTALL &&
      defaultMethodId &&
      methods.some((method) => method.id === defaultMethodId)
    ) {
      return defaultMethodId;
    }
    return methods[0]?.id ?? "default";
  }, [activeMode, defaultMethodId, methods]);

  const selectedMethodId =
    selection?.agentName === agentName && selection.mode === activeMode
      ? selection.methodId
      : resolvedDefault;

  const selectedMethod = useMemo(
    () =>
      methods.find((method) => method.id === selectedMethodId) ?? methods[0],
    [methods, selectedMethodId]
  );

  const requiredBinary = selectedMethod
    ? INSTALL_METHOD_PREREQUISITES[selectedMethod.id]
    : undefined;
  const { available: prereqAvailable } = usePrerequisiteCheck(requiredBinary);

  const handleMethodChange = (methodId: string) => {
    setSelection({ agentName, mode: activeMode, methodId });
  };

  const copySuccessMessage =
    activeMode === CLI_CLIENT_ACTION_TAB.INSTALL
      ? tSettings("cliConfig.copiedInstallScript")
      : t("common:status.copied");

  const onAction =
    activeMode === CLI_CLIENT_ACTION_TAB.INSTALL ? onInstall : onUninstall;

  const actionLabel =
    activeMode === CLI_CLIENT_ACTION_TAB.INSTALL
      ? tSettings("cliConfig.install")
      : tSettings("common:actions.uninstall");

  const methodTabs = methods.map((method) => ({
    key: method.id,
    label: method.label,
  }));

  return (
    <InlineCardSplit
      left={
        <>
          <InlineSplitNavRow
            label={tSettings("cliConfig.install")}
            selected={activeMode === CLI_CLIENT_ACTION_TAB.INSTALL}
            disabled={installMethods.length === 0}
            onSelect={() => setActiveMode(CLI_CLIENT_ACTION_TAB.INSTALL)}
          />
          <InlineSplitNavRow
            label={tSettings("common:actions.uninstall")}
            selected={activeMode === CLI_CLIENT_ACTION_TAB.UNINSTALL}
            disabled={uninstallMethods.length === 0}
            onSelect={() => setActiveMode(CLI_CLIENT_ACTION_TAB.UNINSTALL)}
          />
        </>
      }
      right={
        methods.length === 0 ? (
          <Placeholder
            variant="empty"
            title={
              activeMode === CLI_CLIENT_ACTION_TAB.INSTALL
                ? t("cliPreview.noInstallScript")
                : t("cliPreview.noUninstallScript")
            }
          />
        ) : selectedMethod ? (
          <InlineCardColumnStack>
            <div className="flex h-9 items-center">
              <TabPill
                tabs={methodTabs}
                activeTab={selectedMethodId}
                onChange={handleMethodChange}
                variant="pill"
                fillWidth={false}
                size="small"
              />
            </div>
            <pre className="overflow-x-auto rounded-md border border-border-2 bg-transparent px-3 py-2.5 text-[12px] leading-relaxed text-text-1">
              {selectedMethod.command}
            </pre>
            <div className="flex items-center gap-2">
              {onAction ? (
                <Button
                  variant={
                    activeMode === CLI_CLIENT_ACTION_TAB.UNINSTALL
                      ? "secondary"
                      : "primary"
                  }
                  size="small"
                  icon={
                    activeMode === CLI_CLIENT_ACTION_TAB.INSTALL ? (
                      <Download size={12} />
                    ) : (
                      <Trash2 size={12} />
                    )
                  }
                  onClick={onAction}
                  loading={actionLoading}
                  disabled={actionDisabled || !prereqAvailable}
                  className={
                    activeMode === CLI_CLIENT_ACTION_TAB.UNINSTALL
                      ? "text-danger-6 hover:text-danger-5"
                      : ""
                  }
                >
                  {actionLabel}
                </Button>
              ) : null}
              <Button
                size="small"
                icon={<Copy size={12} />}
                onClick={() => {
                  navigator.clipboard
                    .writeText(selectedMethod.command)
                    .then(() => {
                      Message.success({ content: copySuccessMessage });
                    });
                }}
              >
                {tSettings("common:actions.copy")}
              </Button>
            </div>
            {requiredBinary && !prereqAvailable ? (
              <PrerequisiteAlert binary={requiredBinary} />
            ) : null}
          </InlineCardColumnStack>
        ) : null
      }
    />
  );
};
