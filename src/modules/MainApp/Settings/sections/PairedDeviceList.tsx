import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { PairedDeviceInfo } from "@src/api/tauri/mobileRemote";
import Button from "@src/components/Button";
import StatusDot from "@src/components/StatusDot";
import { SECTION_VALUE_SMALL_MUTED_CLASSES } from "@src/modules/shared/layouts/SectionLayout";

import {
  formatPairedDeviceSubtitle,
  formatPairedDeviceTierLabel,
  formatPairedDeviceTitle,
  isPairedDeviceReadOnlyTier,
  resolvePairedDevicePresence,
  sortPairedDevicesByLastSeen,
} from "./pairedDeviceDisplay";

export interface PairedDeviceListProps {
  devices: readonly PairedDeviceInfo[];
  formatTimestamp: (ms: number | null) => string;
  onRevoke: (deviceId: string) => void;
}

const PairedDeviceList: React.FC<PairedDeviceListProps> = ({
  devices,
  formatTimestamp,
  onRevoke,
}) => {
  const { t } = useTranslation("settings");
  const sortedDevices = useMemo(
    () => sortPairedDevicesByLastSeen(devices),
    [devices]
  );

  return (
    <div
      className="flex max-h-64 flex-col divide-y divide-border-2 overflow-y-auto rounded-xl border border-border-2 bg-bg-2"
      data-testid="mobile-remote-paired-device-list"
    >
      {sortedDevices.map((device) => {
        const presence = resolvePairedDevicePresence(device.lastSeenMs);
        const showTierBadge = isPairedDeviceReadOnlyTier(device.tier);
        const title = formatPairedDeviceTitle(device);
        const subtitle = formatPairedDeviceSubtitle(device, formatTimestamp, t);

        return (
          <div
            key={device.deviceId}
            className="flex items-start gap-3 px-3 py-2.5"
            data-testid={`mobile-remote-paired-device-${device.deviceId}`}
          >
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-center gap-2">
                <StatusDot
                  color={presence === "online" ? "bg-success-6" : "bg-text-4"}
                  size="sm"
                  ariaLabel={
                    presence === "online"
                      ? t("mobileRemote.deviceOnline")
                      : t("mobileRemote.deviceOffline")
                  }
                />
                <span
                  className="min-w-0 truncate text-[13px] font-medium text-text-1"
                  title={title}
                >
                  {title}
                </span>
                {showTierBadge ? (
                  <span
                    className={`shrink-0 rounded-md border border-border-2 bg-fill-1 px-1.5 py-0.5 text-[10px] leading-none text-text-2`}
                  >
                    {formatPairedDeviceTierLabel(device.tier, t)}
                  </span>
                ) : null}
              </div>
              <p
                className={`mt-0.5 truncate pl-4.5 ${SECTION_VALUE_SMALL_MUTED_CLASSES}`}
                title={subtitle}
              >
                {subtitle}
              </p>
            </div>
            <Button
              variant="danger"
              appearance="ghost"
              size="small"
              className="shrink-0"
              onClick={() => onRevoke(device.deviceId)}
            >
              {t("mobileRemote.revokeDevice")}
            </Button>
          </div>
        );
      })}
    </div>
  );
};

export default PairedDeviceList;
