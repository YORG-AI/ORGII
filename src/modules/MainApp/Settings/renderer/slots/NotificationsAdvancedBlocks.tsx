import {
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import React, { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type NotificationPermissionStatus,
  checkNotificationPermission,
  playCompletionSound,
  requestNotificationPermission,
  sendTestNotification,
} from "@src/api/services/notification";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Slider from "@src/components/Slider";
import Switch from "@src/components/Switch";
import { NAV_BUTTON_PROPS } from "@src/modules/MainApp/Settings/config";
import { useSetting } from "@src/store/settings";
import { isMacOS } from "@src/util/platform/tauri";

interface NotificationCategoryConfig {
  key: "taskCompletion" | "errors" | "teamInbox";
  labelKey: string;
}

const NOTIFICATION_CATEGORIES: NotificationCategoryConfig[] = [
  {
    key: "taskCompletion",
    labelKey: "notifications.taskCompletion",
  },
  {
    key: "errors",
    labelKey: "notifications.errors",
  },
  {
    key: "teamInbox",
    labelKey: "notifications.teamInbox",
  },
];

const NotificationsAdvancedBlocks: React.FC = () => {
  const { t } = useTranslation("settings");
  const [enabled] = useSetting("notifications.enabled");
  const [completionSound, setCompletionSound] = useSetting(
    "notifications.completionSound"
  );
  const [systemNotificationEnabled, setSystemNotificationEnabled] = useSetting(
    "notifications.systemNotificationEnabled"
  );
  const [dockBadgeEnabled, setDockBadgeEnabled] = useSetting(
    "notifications.dockBadgeEnabled"
  );
  const [soundVolume, setSoundVolume] = useSetting("notifications.soundVolume");
  const [taskCompletion, setTaskCompletion] = useSetting(
    "notifications.categories.taskCompletion"
  );
  const [errors, setErrors] = useSetting("notifications.categories.errors");
  const [teamInbox, setTeamInbox] = useSetting(
    "notifications.categories.teamInbox"
  );

  const [permissionStatus, setPermissionStatus] =
    useState<NotificationPermissionStatus>("unknown");
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    checkNotificationPermission().then((status) => {
      if (!cancelled) {
        setPermissionStatus(status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const ensureSystemPermission =
    async (): Promise<NotificationPermissionStatus> => {
      if (permissionStatus === "granted") return permissionStatus;
      setIsRequestingPermission(true);
      try {
        const result = await requestNotificationPermission();
        setPermissionStatus(result);
        if (result !== "granted") {
          Message.warning(t("notifications.permissionDenied"));
        }
        return result;
      } finally {
        setIsRequestingPermission(false);
      }
    };

  const handleToggleSystemNotification = async () => {
    if (systemNotificationEnabled) {
      setSystemNotificationEnabled(false);
      return;
    }
    if ((await ensureSystemPermission()) === "granted") {
      setSystemNotificationEnabled(true);
    }
  };

  const handleTestNotification = async () => {
    setIsTesting(true);
    try {
      if ((await ensureSystemPermission()) !== "granted") return;
      const success = await sendTestNotification();
      if (success) {
        Message.success(t("notifications.test.sent"));
      } else {
        Message.warning(t("notifications.test.permissionWarning"));
      }
    } catch {
      Message.error(t("notifications.test.sendFailed"));
    } finally {
      setIsTesting(false);
    }
  };

  const handleVolumeChange: (value: number | [number, number]) => void = (
    value
  ) => {
    const nextVolume = Array.isArray(value) ? value[0] : value;
    setSoundVolume(nextVolume);
  };

  const categoryValues = {
    taskCompletion,
    errors,
    teamInbox,
  };

  const categorySetters = {
    taskCompletion: setTaskCompletion,
    errors: setErrors,
    teamInbox: setTeamInbox,
  } as const;

  if (!enabled) {
    return null;
  }

  return (
    <>
      <SectionContainer>
        <SectionRow label={t("notifications.enableSound")}>
          <Switch
            checked={completionSound}
            onChange={() => setCompletionSound(!completionSound)}
          />
        </SectionRow>

        {completionSound && (
          <SectionRow label={t("notifications.volume")}>
            <div className="w-[160px] max-w-full">
              <Slider
                value={soundVolume}
                onChange={handleVolumeChange}
                min={0}
                max={100}
                showTooltip={false}
                noPadding
              />
            </div>
          </SectionRow>
        )}
      </SectionContainer>

      <SectionContainer>
        {NOTIFICATION_CATEGORIES.map((category) => (
          <SectionRow key={category.key} label={t(category.labelKey)}>
            <Switch
              checked={categoryValues[category.key]}
              onChange={() =>
                categorySetters[category.key](!categoryValues[category.key])
              }
            />
          </SectionRow>
        ))}
      </SectionContainer>

      <SectionContainer>
        <SectionRow label={t("notifications.enableSystem")}>
          <Switch
            checked={systemNotificationEnabled}
            disabled={isRequestingPermission}
            onChange={() => void handleToggleSystemNotification()}
          />
        </SectionRow>
        {(systemNotificationEnabled || permissionStatus !== "unknown") && (
          <SectionRow
            label={t("notifications.systemPermission")}
            indent
            description={
              permissionStatus === "granted"
                ? t("notifications.notificationsAllowed")
                : permissionStatus === "denied"
                  ? t("notifications.notificationsBlocked")
                  : t("notifications.permissionNotRequested")
            }
          >
            <div className="flex items-center gap-2">
              <span className="whitespace-nowrap text-xs text-text-1">
                {permissionStatus === "granted"
                  ? t("notifications.granted")
                  : permissionStatus === "denied"
                    ? t("notifications.denied")
                    : t("common:status.unknown")}
              </span>
              {isMacOS() && (
                <Button
                  {...NAV_BUTTON_PROPS}
                  onClick={() => {
                    shellOpen(
                      "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
                    );
                  }}
                >
                  {t("common:actions.configure")}
                </Button>
              )}
            </div>
          </SectionRow>
        )}
      </SectionContainer>

      <SectionContainer>
        <SectionRow label={t("notifications.enableDockBadge")}>
          <Switch
            checked={dockBadgeEnabled}
            onChange={() => setDockBadgeEnabled(!dockBadgeEnabled)}
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <SectionRow label={t("notifications.testNotification")}>
          <div className="flex items-center gap-2">
            <Button
              size="default"
              onClick={handleTestNotification}
              loading={isTesting}
              disabled={isRequestingPermission}
            >
              {t("notifications.notification")}
            </Button>
            <Button
              size="default"
              onClick={() => void playCompletionSound(soundVolume)}
              disabled={!completionSound}
            >
              {t("notifications.sound")}
            </Button>
          </div>
        </SectionRow>
      </SectionContainer>
    </>
  );
};

export default NotificationsAdvancedBlocks;
