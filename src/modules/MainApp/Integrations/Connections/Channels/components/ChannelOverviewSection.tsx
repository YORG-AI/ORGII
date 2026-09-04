/**
 * ChannelOverviewSection
 *
 * Displays channel overview info using the shared InfoCard pattern.
 * Shows type, account ID, live connection status, and last probe result.
 */
import React from "react";
import { useTranslation } from "react-i18next";

import IntegrationIcon from "@src/components/IntegrationIcon";
import { ChevronsLeftRightEllipsisIcon, HugeiconsIcon } from "@src/icons";
import { InfoCard } from "@src/modules/shared/layouts/blocks";

import { CHANNEL_TYPES } from "../config";
import {
  type ChannelConnectionStatus,
  type ChannelProbeResult,
  STATUS_I18N_KEY,
  STATUS_TEXT_COLOR,
} from "../types";

interface ChannelOverviewSectionProps {
  channelType: string;
  accountId: string;
  enabled: boolean;
  connectionStatus: ChannelConnectionStatus;
  connectionError?: string;
  probeResult: ChannelProbeResult | null;
}

const ChannelOverviewSection: React.FC<ChannelOverviewSectionProps> = ({
  channelType,
  accountId,
  connectionStatus,
  connectionError,
  probeResult,
}) => {
  const { t } = useTranslation("integrations");

  const channelLabel =
    CHANNEL_TYPES.find((ct) => ct.type === channelType)?.labelKey ??
    channelType;

  const colorClass = STATUS_TEXT_COLOR[connectionStatus];

  return (
    <InfoCard
      rows={[
        {
          label: t("common:common.type"),
          value: (
            <span className="flex items-center gap-1.5">
              <IntegrationIcon type={channelType} size={14} />
              {t(channelLabel)}
            </span>
          ),
        },
        {
          label: t("channels.overview.account"),
          value: accountId,
        },
        {
          label: t("common:common.status"),
          value: (
            <span className="flex items-center gap-1.5">
              <HugeiconsIcon
                icon={ChevronsLeftRightEllipsisIcon}
                data-icon="chevrons-left-right-ellipsis"
                size={16}
                className={colorClass}
              />
              <span className={colorClass}>
                {t(STATUS_I18N_KEY[connectionStatus])}
              </span>
            </span>
          ),
        },
        ...(connectionStatus === "error" && connectionError
          ? [
              {
                label: t("common:common.error"),
                value: <span className="text-danger-6">{connectionError}</span>,
              },
            ]
          : []),
        {
          label: t("channels.overview.lastProbe"),
          value: probeResult ? (
            <span
              className={`${probeResult.ok ? "text-success-6" : "text-danger-6"}`}
            >
              {probeResult.ok
                ? t("integrations.probeSuccess")
                : t("integrations.probeFailed")}
              {" · "}
              {probeResult.elapsed_ms}ms
            </span>
          ) : (
            <span className="text-text-3">—</span>
          ),
        },
      ]}
    />
  );
};

export default ChannelOverviewSection;
