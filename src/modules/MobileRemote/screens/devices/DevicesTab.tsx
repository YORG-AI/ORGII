import React from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import InlineAlert from "@src/components/InlineAlert";
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
import type {
  DesktopPresence,
  MobilePairedDesktopSummary,
} from "../../connection/types";

export interface PairedDesktopRow {
  id: string;
  name: string;
  presence: DesktopPresence;
  primary?: boolean;
}

export function derivePairedDesktopsFromInventory(input: {
  desktops: MobilePairedDesktopSummary[];
  activePresence: DesktopPresence;
}): PairedDesktopRow[] {
  return input.desktops.map((desktop) => ({
    id: desktop.id,
    name: desktop.name,
    presence: desktop.active ? input.activePresence : "offline",
    primary: desktop.active,
  }));
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
  const [switchingDesktopId, setSwitchingDesktopId] = React.useState<
    string | null
  >(null);
  const [switchError, setSwitchError] = React.useState<string | null>(null);
  const {
    connection,
    pairedDesktops: pairedDesktopInventory,
    switchPairedDesktop,
  } = useMobileRemote();
  const pairedDesktops = derivePairedDesktopsFromInventory({
    desktops: pairedDesktopInventory,
    activePresence: connection.presence,
  });

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
                className={`block max-w-full min-w-0 truncate text-right ${SECTION_VALUE_SMALL_MUTED_CLASSES}`}
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
                    className="py-1"
                    label={
                      <Button
                        variant="tertiary"
                        appearance="ghost"
                        long
                        className="min-w-0 justify-start text-left disabled:cursor-default"
                        style={{ height: 44, minHeight: 44, padding: 0 }}
                        disabled={
                          desktop.primary || switchingDesktopId !== null
                        }
                        loading={switchingDesktopId === desktop.id}
                        aria-busy={switchingDesktopId === desktop.id}
                        aria-current={desktop.primary ? "true" : undefined}
                        aria-label={
                          desktop.primary
                            ? undefined
                            : t("devices.switchTo", { name: desktop.name })
                        }
                        icon={
                          <HugeiconsIcon
                            icon={LaptopIcon}
                            size={16}
                            className="shrink-0 text-text-3"
                            aria-hidden="true"
                          />
                        }
                        onClick={async () => {
                          setSwitchError(null);
                          setSwitchingDesktopId(desktop.id);
                          try {
                            await switchPairedDesktop(desktop.id);
                          } catch {
                            setSwitchError(t("devices.switchFailed"));
                          } finally {
                            setSwitchingDesktopId(null);
                          }
                        }}
                      >
                        <span className="truncate">{desktop.name}</span>
                        {desktop.primary ? (
                          <span
                            className={`shrink-0 font-normal ${SECTION_VALUE_SMALL_MUTED_CLASSES}`}
                          >
                            · {t("devices.primary")}
                          </span>
                        ) : null}
                      </Button>
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
                {switchError ? (
                  <SectionRow showHeader={false} compact>
                    <InlineAlert
                      type="danger"
                      role="alert"
                      compact
                      className="w-full"
                    >
                      {switchError}
                    </InlineAlert>
                  </SectionRow>
                ) : null}
              </>
            )}
          </SectionContainer>
        </div>
      </div>
    </>
  );
}

DevicesTab.displayName = "DevicesTab";
