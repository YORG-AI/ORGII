import React from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import StatusDot from "@src/components/StatusDot";

import { useMobileRemote } from "../../app";
import { MobileTopBar } from "../../components/MobileTopBar";
import type { DesktopPresence } from "../../connection/types";

export interface PairedDesktopRow {
  id: string;
  name: string;
  presence: DesktopPresence;
  primary?: boolean;
}

export function derivePairedDesktopsFromConnection(input: {
  desktopId?: string;
  desktopName?: string;
  presence: DesktopPresence;
}): PairedDesktopRow[] {
  if (!input.desktopName?.trim()) {
    return [];
  }
  return [
    {
      id: input.desktopId ?? input.desktopName,
      name: input.desktopName,
      presence: input.presence,
      primary: true,
    },
  ];
}

function resolveDotColor(presence: DesktopPresence): string {
  switch (presence) {
    case "online":
      return "bg-success-6";
    case "offline":
      return "bg-text-4";
    default:
      return "bg-warning-6";
  }
}

/** M-16 Devices — local device stub + paired desktop list from connection context. */
export function DevicesTab() {
  const { t } = useTranslation("mobileRemote");
  const { connection } = useMobileRemote();
  const pairedDesktops = derivePairedDesktopsFromConnection(connection);

  return (
    <>
      <MobileTopBar title={t("devices.title")} />
      <div className="flex-1 overflow-y-auto px-4 py-4">
        <div className="pb-2 text-xs font-medium uppercase tracking-wide text-text-3">
          {t("devices.thisDevice")}
        </div>
        <div className="mb-5 rounded-xl border border-border-2 bg-bg-2 px-4 py-3">
          <div className="text-sm font-semibold text-text-1">
            {t("devices.thisDeviceLabel")}
          </div>
          <div className="mt-1 text-xs text-text-3">
            {t("devices.thisDeviceSubtitle")}
          </div>
        </div>

        <div className="pb-2 text-xs font-medium uppercase tracking-wide text-text-3">
          {t("devices.pairedDesktops")}
        </div>
        {pairedDesktops.length === 0 ? (
          <Placeholder
            variant="empty"
            title={t("devices.emptyDesktops")}
            className="py-8"
          />
        ) : (
          <div className="flex flex-col gap-2">
            {pairedDesktops.map((desktop) => (
              <div
                key={desktop.id}
                className="flex items-center gap-3 rounded-xl border border-border-2 bg-bg-2 px-3 py-3"
              >
                <StatusDot
                  color={resolveDotColor(desktop.presence)}
                  size="inline"
                  pulse={desktop.presence === "unknown"}
                />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text-1">
                    {desktop.name}
                    {desktop.primary ? ` · ${t("devices.primary")}` : null}
                  </div>
                  {desktop.presence === "offline" ? (
                    <div className="text-xs text-text-3">
                      {t("devices.offline")}
                    </div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

DevicesTab.displayName = "DevicesTab";
