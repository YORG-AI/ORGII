/**
 * QuickActionsSection
 *
 * Quick action cards for channel detail panel.
 * Shows live connection status with four states:
 * connected (green), reconnecting (yellow), error (red), disabled (gray).
 * On error, shows a "Reconnect" button to re-toggle the channel.
 */
import React, { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";

import ActionCard from "@src/components/ActionCard";
import AnyIcon from "@src/components/AnyIcon";
import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
import Switch from "@src/components/Switch";
import {
  Delete02Icon,
  HugeiconsIcon,
  Refresh04Icon,
  Wifi01Icon,
} from "@src/icons";
import {
  STATUS_BAR_TOKENS,
  STATUS_ICON,
  STATUS_ICON_SIZE,
} from "@src/modules/MainApp/Integrations/panelTokens";
import { DETAIL_PANEL_TOKENS } from "@src/modules/shared/layouts/blocks";

import {
  type ChannelConnectionStatus,
  STATUS_I18N_KEY,
  STATUS_TEXT_COLOR,
} from "../types";

interface QuickActionsSectionProps {
  onTestConnection: () => void;
  onRemove: () => void;
  onToggleEnabled: (enabled: boolean) => void;
  enabled: boolean;
  connectionStatus: ChannelConnectionStatus;
  connectionError?: string;
  probing?: boolean;
}

const RECONNECT_DELAY_MS = 500;

const QuickActionsSection: React.FC<QuickActionsSectionProps> = ({
  onTestConnection,
  onRemove,
  onToggleEnabled,
  enabled,
  connectionStatus,
  connectionError,
  probing = false,
}) => {
  const { t } = useTranslation("integrations");
  const [reconnecting, setReconnecting] = useState(false);

  const handleReconnect = useCallback(async () => {
    setReconnecting(true);
    onToggleEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_DELAY_MS));
    onToggleEnabled(true);
    setReconnecting(false);
  }, [onToggleEnabled]);

  const colorClass = STATUS_TEXT_COLOR[connectionStatus];

  return (
    <div className={DETAIL_PANEL_TOKENS.contentStack}>
      {/* Status line */}
      <div className={STATUS_BAR_TOKENS.container}>
        <span className={STATUS_BAR_TOKENS.label}>
          <AnyIcon
            icon={STATUS_ICON}
            size={STATUS_ICON_SIZE}
            className={colorClass}
          />
          <span className={STATUS_BAR_TOKENS.labelText}>
            {t("common:common.status")}:
          </span>
          <span className={colorClass}>
            {t(STATUS_I18N_KEY[connectionStatus])}
          </span>
        </span>
        <div className="flex items-center gap-2">
          {connectionStatus === "error" && (
            <Button
              variant="primary"
              appearance="outline"
              size="small"
              icon={
                <HugeiconsIcon
                  icon={Refresh04Icon}
                  data-icon="refresh-cw"
                  size={14}
                />
              }
              onClick={() => handleReconnect()}
              disabled={reconnecting}
              loading={reconnecting}
              loadingSpinIcon
            >
              {t("integrations.reconnect")}
            </Button>
          )}
          <Switch checked={enabled} onCheckedChange={onToggleEnabled} />
        </div>
      </div>

      {/* Error message */}
      {connectionStatus === "error" && connectionError && (
        <InlineAlert
          type="danger"
          title={t("common:status.error")}
          action={{
            label: t("integrations.reconnect"),
            onClick: handleReconnect,
          }}
        >
          {connectionError}
        </InlineAlert>
      )}

      {/* Action cards */}
      <div className="grid grid-cols-2 gap-2 max-[480px]:grid-cols-1">
        <ActionCard
          icon={Wifi01Icon}
          title={t("integrations.testConnection")}
          description={t("channels.quickActions.testConnectionDesc")}
          variant="default"
          onClick={onTestConnection}
          disabled={probing}
          showArrow
        />

        <ActionCard
          icon={Delete02Icon}
          title={t("channels.quickActions.remove")}
          description={t("channels.quickActions.removeDesc")}
          variant="default"
          onClick={onRemove}
          showArrow
        />
      </div>
    </div>
  );
};

export default QuickActionsSection;
