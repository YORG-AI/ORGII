import {
  SECTION_ACTION_GAP_CLASSES,
  SECTION_CONTROL_STYLE,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { open as shellOpen } from "@tauri-apps/plugin-shell";
import { useAtomValue } from "jotai";
import { Play } from "lucide-react";
import React, { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type NotificationPermissionStatus,
  checkNotificationPermission,
  playNotificationSound,
  requestNotificationPermission,
  sendTestNotification,
  setDockBadge,
  unlockNotificationSound,
} from "@src/api/services/notification";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import Slider from "@src/components/Slider";
import Switch from "@src/components/Switch";
import {
  NOTIFICATION_SOUND_PRESETS,
  normalizeNotificationSoundPreset,
} from "@src/config/notificationSounds";
import type { NotificationSoundPreset } from "@src/config/notificationSounds";
import { NAV_BUTTON_PROPS } from "@src/modules/MainApp/Settings/config";
import { useSetting } from "@src/store/settings";
import { notificationSettingsAtom } from "@src/store/ui/notificationAtom";
import type { NotificationCategory } from "@src/types/ui/notification";
import { isMacOS } from "@src/util/platform/tauri";

import NotificationFocusBlocks from "./NotificationFocusBlocks";

interface NotificationCategoryConfig {
  key: NotificationCategory;
  labelKey: string;
  critical: boolean;
}

const NOTIFICATION_CATEGORIES: NotificationCategoryConfig[] = [
  {
    key: "taskCompletion",
    labelKey: "notifications.taskCompletion",
    critical: false,
  },
  {
    key: "agentApproval",
    labelKey: "notifications.agentApproval",
    critical: true,
  },
  {
    key: "errors",
    labelKey: "notifications.errors",
    critical: true,
  },
  {
    key: "teamInbox",
    labelKey: "notifications.teamInbox",
    critical: false,
  },
];

const NotificationsAdvancedBlocks: React.FC = () => {
  const { t } = useTranslation("settings");
  const notificationSettings = useAtomValue(notificationSettingsAtom);
  const [enabled] = useSetting("notifications.enabled");
  const [soundEnabled, setSoundEnabled] = useSetting(
    "notifications.completionSound"
  );
  const [soundPreset, setSoundPreset] = useSetting("notifications.soundPreset");
  const [systemNotificationEnabled, setSystemNotificationEnabled] = useSetting(
    "notifications.systemNotificationEnabled"
  );
  const [dockBadgeEnabled, setDockBadgeEnabled] = useSetting(
    "notifications.dockBadgeEnabled"
  );
  const [soundVolume, setSoundVolume] = useSetting("notifications.soundVolume");
  const [criticalOnly] = useSetting("notifications.criticalOnly");
  const [taskCompletion, setTaskCompletion] = useSetting(
    "notifications.categories.taskCompletion"
  );
  const [agentApproval, setAgentApproval] = useSetting(
    "notifications.categories.agentApproval"
  );
  const [errors, setErrors] = useSetting("notifications.categories.errors");
  const [teamInbox, setTeamInbox] = useSetting(
    "notifications.categories.teamInbox"
  );

  const [permissionStatus, setPermissionStatus] =
    useState<NotificationPermissionStatus>("unknown");
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const soundPresetOptions = useMemo(
    () =>
      NOTIFICATION_SOUND_PRESETS.map((preset) => ({
        value: preset,
        label: t(`notifications.soundPresets.${preset}`),
      })),
    [t]
  );

  useEffect(() => {
    let cancelled = false;
    checkNotificationPermission().then((status) => {
      if (!cancelled) setPermissionStatus(status);
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
      const success = await sendTestNotification(notificationSettings);
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

  const handleToggleDockBadge = () => {
    const nextEnabled = !dockBadgeEnabled;
    setDockBadgeEnabled(nextEnabled);
    if (!nextEnabled) void setDockBadge(0);
  };

  const handleVolumeChange: (value: number | [number, number]) => void = (
    value
  ) => {
    setSoundVolume(Array.isArray(value) ? value[0] : value);
  };

  const handleSoundEnabledChange = () => {
    const nextSoundEnabled = !soundEnabled;
    setSoundEnabled(nextSoundEnabled);
    if (nextSoundEnabled) void unlockNotificationSound();
  };

  const handlePreviewSound = async (preset: NotificationSoundPreset) => {
    const played = await playNotificationSound({
      preset,
      volume: soundVolume,
    });
    if (!played && soundVolume > 0) {
      Message.warning(t("notifications.test.soundFailed"));
    }
  };

  const handleSoundPresetChange = (value: unknown) => {
    const nextPreset = normalizeNotificationSoundPreset(value);
    setSoundPreset(nextPreset);
    void handlePreviewSound(nextPreset);
  };

  const categoryValues = {
    taskCompletion,
    agentApproval,
    errors,
    teamInbox,
  };

  const categorySetters = {
    taskCompletion: setTaskCompletion,
    agentApproval: setAgentApproval,
    errors: setErrors,
    teamInbox: setTeamInbox,
  } as const;

  if (!enabled) return null;

  return (
    <>
      <NotificationFocusBlocks />

      <SectionContainer>
        <SectionRow label={t("notifications.enableSound")}>
          <Switch
            checked={soundEnabled}
            onCheckedChange={handleSoundEnabledChange}
          />
        </SectionRow>

        {soundEnabled && (
          <>
            <SectionRow
              label={t("notifications.soundPreset")}
              description={t("notifications.soundPresetDesc")}
              indent
            >
              <div
                className={`${SECTION_ACTION_GAP_CLASSES} w-full flex-wrap`}
                style={SECTION_CONTROL_STYLE}
              >
                <div className="min-w-0 flex-1">
                  <Select
                    value={soundPreset}
                    onChange={handleSoundPresetChange}
                    options={soundPresetOptions}
                    size="default"
                    style={{ width: "100%" }}
                    dataTestId="notification-sound-preset-select"
                  />
                </div>
                <Button
                  size="default"
                  icon={<Play size={14} />}
                  onClick={() => void handlePreviewSound(soundPreset)}
                  disabled={soundVolume === 0}
                >
                  {t("notifications.previewSound")}
                </Button>
              </div>
            </SectionRow>
            <SectionRow label={t("notifications.volume")} indent>
              <div className="w-[160px] max-w-full">
                <Slider
                  value={soundVolume}
                  onValueChange={handleVolumeChange}
                  min={0}
                  max={100}
                  showTooltip={false}
                  noPadding
                />
              </div>
            </SectionRow>
          </>
        )}
      </SectionContainer>

      <SectionContainer>
        {NOTIFICATION_CATEGORIES.map((category) => (
          <SectionRow key={category.key} label={t(category.labelKey)}>
            <Switch
              checked={categoryValues[category.key]}
              disabled={criticalOnly && !category.critical}
              onCheckedChange={() =>
                categorySetters[category.key](!categoryValues[category.key])
              }
              ariaLabel={t(category.labelKey)}
            />
          </SectionRow>
        ))}
      </SectionContainer>

      <SectionContainer>
        <SectionRow label={t("notifications.enableSystem")}>
          <Switch
            checked={systemNotificationEnabled}
            disabled={isRequestingPermission}
            onCheckedChange={() => void handleToggleSystemNotification()}
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
            onCheckedChange={handleToggleDockBadge}
          />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <SectionRow label={t("notifications.testNotification")}>
          <Button
            size="default"
            onClick={handleTestNotification}
            loading={isTesting}
            disabled={isRequestingPermission}
          >
            {t("notifications.notification")}
          </Button>
        </SectionRow>
      </SectionContainer>
    </>
  );
};

export default NotificationsAdvancedBlocks;
