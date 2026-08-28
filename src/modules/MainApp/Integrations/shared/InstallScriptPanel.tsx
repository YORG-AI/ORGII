/**
 * InstallScriptPanel
 *
 * Right-side content for an install / uninstall inline section.
 * Shows the package-manager pill row (optional), the command preview,
 * install / uninstall / copy buttons, and a prerequisite alert.
 *
 * Used by CLI Clients, LSP, and Lint Tools inline expanded cards.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import Message from "@src/components/Message";
import PrerequisiteAlert from "@src/components/PrerequisiteAlert";
import TabPill from "@src/components/TabPill";
import type { TabPillItem } from "@src/components/TabPill";
import {
  Copy01Icon,
  Delete02Icon,
  Download01Icon,
  HugeiconsIcon,
} from "@src/icons";
import { copyText } from "@src/util/data/clipboard";

import { InlineCardColumnStack } from "../KeyVault/shared/InlineCardPrimitives";

export type InstallScriptMode = "install" | "uninstall";

interface InstallScriptPanelProps {
  mode: InstallScriptMode;
  command: string;
  /** Optional pill tabs for switching package manager / install method. */
  methodTabs?: TabPillItem[];
  activeMethodKey?: string;
  onMethodChange?: (key: string) => void;
  onAction?: () => void;
  actionLoading?: boolean;
  actionDisabled?: boolean;
  /** Optional binary name to gate the action behind a prerequisite check. */
  prerequisiteBinary?: string | null;
  prerequisiteAvailable?: boolean;
  copySuccessMessage?: string;
}

export const InstallScriptPanel: React.FC<InstallScriptPanelProps> = ({
  mode,
  command,
  methodTabs,
  activeMethodKey,
  onMethodChange,
  onAction,
  actionLoading,
  actionDisabled,
  prerequisiteBinary,
  prerequisiteAvailable = true,
  copySuccessMessage,
}) => {
  const { t } = useTranslation("integrations");
  const { t: tCommon } = useTranslation();
  const { t: tSettings } = useTranslation("settings");

  const actionLabel =
    mode === "install"
      ? tSettings("cliConfig.install")
      : tCommon("actions.uninstall");

  const handleCopy = () => {
    copyText(command)
      .then(() => {
        Message.success({
          content: copySuccessMessage ?? tCommon("status.copied"),
        });
      })
      .catch(() => {
        Message.error({ content: tCommon("status.copyFailed") });
      });
  };

  return (
    <InlineCardColumnStack>
      {methodTabs &&
      methodTabs.length > 0 &&
      activeMethodKey &&
      onMethodChange ? (
        <div className="flex h-9 items-center">
          <TabPill
            tabs={methodTabs}
            activeTab={activeMethodKey}
            onChange={onMethodChange}
            variant="pill"
            fillWidth={false}
            size="small"
          />
        </div>
      ) : null}
      <pre className="overflow-x-auto rounded-md border border-border-2 bg-transparent px-3 py-2.5 text-[12px] leading-relaxed text-text-1">
        {command}
      </pre>
      <div className="flex items-center gap-2">
        {onAction ? (
          <Button
            variant={mode === "uninstall" ? "secondary" : "primary"}
            size="small"
            icon={
              mode === "install" ? (
                <HugeiconsIcon
                  icon={Download01Icon}
                  data-icon="download"
                  size={12}
                />
              ) : (
                <HugeiconsIcon
                  icon={Delete02Icon}
                  data-icon="trash-2"
                  size={12}
                />
              )
            }
            onClick={onAction}
            loading={actionLoading}
            disabled={actionDisabled || !prerequisiteAvailable}
            className={
              mode === "uninstall" ? "text-danger-6 hover:text-danger-5" : ""
            }
          >
            {actionLabel}
          </Button>
        ) : null}
        <Button
          size="small"
          icon={<HugeiconsIcon icon={Copy01Icon} data-icon="copy" size={12} />}
          onClick={handleCopy}
        >
          {t("common:actions.copy")}
        </Button>
      </div>
      {prerequisiteBinary && !prerequisiteAvailable ? (
        <PrerequisiteAlert binary={prerequisiteBinary} />
      ) : null}
    </InlineCardColumnStack>
  );
};
