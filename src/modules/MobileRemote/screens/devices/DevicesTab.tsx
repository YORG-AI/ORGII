import React from "react";
import { useTranslation } from "react-i18next";

import { Placeholder } from "@src/components/Placeholder";
import StatusDot from "@src/components/StatusDot";
import { HugeiconsIcon, LaptopIcon, SmartPhone01Icon } from "@src/icons";
import {
  SECTION_VALUE_SMALL_MUTED_CLASSES,
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";

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

function resolvePresenceLabel(
  presence: DesktopPresence,
  t: (key: string) => string
): string {
  switch (presence) {
    case "online":
      return t("devices.online");
    case "offline":
      return t("devices.offline");
    default:
      return t("devices.unknown");
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
        <div className="flex flex-col gap-5">
          <SectionContainer
            title={t("devices.thisDevice")}
            dataTestId="mobile-remote-this-device"
          >
            <SectionRow
              layout="inline"
              label={
                <span className="flex min-w-0 items-center gap-2">
                  <HugeiconsIcon
                    icon={SmartPhone01Icon}
                    size={16}
                    className="shrink-0 text-text-3"
                    aria-hidden="true"
                  />
                  <span className="truncate">
                    {t("devices.thisDeviceLabel")}
                  </span>
                </span>
              }
            >
              <span
                className={`block min-w-0 max-w-full truncate text-right ${SECTION_VALUE_SMALL_MUTED_CLASSES}`}
              >
                {t("devices.thisDeviceSubtitle")}
              </span>
            </SectionRow>
          </SectionContainer>

          <SectionContainer
            title={t("devices.pairedDesktops")}
            padding={pairedDesktops.length === 0 ? "default" : "none"}
            dataTestId="mobile-remote-paired-desktops"
          >
            {pairedDesktops.length === 0 ? (
              <Placeholder
                variant="empty"
                title={t("devices.emptyDesktops")}
                className="py-6"
              />
            ) : (
              <>
                {pairedDesktops.map((desktop) => (
                  <SectionRow
                    key={desktop.id}
                    layout="inline"
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <HugeiconsIcon
                          icon={LaptopIcon}
                          size={16}
                          className="shrink-0 text-text-3"
                          aria-hidden="true"
                        />
                        <span className="truncate">{desktop.name}</span>
                        {desktop.primary ? (
                          <span
                            className={`shrink-0 font-normal ${SECTION_VALUE_SMALL_MUTED_CLASSES}`}
                          >
                            · {t("devices.primary")}
                          </span>
                        ) : null}
                      </span>
                    }
                  >
                    <StatusDot
                      color={resolveDotColor(desktop.presence)}
                      label={resolvePresenceLabel(desktop.presence, t)}
                      size="inline"
                      pulse={desktop.presence === "unknown"}
                    />
                  </SectionRow>
                ))}
              </>
            )}
          </SectionContainer>
        </div>
      </div>
    </>
  );
}

DevicesTab.displayName = "DevicesTab";
