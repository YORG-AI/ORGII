/**
 * General Settings Section
 *
 * Hosts three tabs:
 *   - `general` — account, language/date, security, update, settings file
 *   - `notifications` — master toggle + advanced blocks (lazy)
 *   - `shortcuts` — keyboard shortcuts viewer (lazy)
 *
 * The General tab is rendered eagerly; the heavier Notifications and
 * Shortcuts tabs are code-split so they only load when the user clicks
 * into them.
 */
import {
  PathCopyOpenRow,
  SECTION_CONTROL_STYLE,
  SECTION_VALUE_TEXT_CLASSES,
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import { Placeholder } from "@/src/modules/shared/layouts/blocks";
import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { useAtom } from "jotai";
import { RefreshCw } from "lucide-react";
import React, {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useTranslation } from "react-i18next";

import {
  type MicrophonePermissionStatus,
  canOpenMicrophoneSystemSettings,
  checkMicrophonePermission,
  openMicrophoneSystemSettings,
  requestMicrophonePermission,
} from "@src/api/services/microphone";
import Button from "@src/components/Button";
import Message from "@src/components/Message";
import Select from "@src/components/Select";
import Switch from "@src/components/Switch";
import { useTimezoneSelect } from "@src/hooks/geo";
import {
  LANGUAGE_NAMES,
  LANGUAGE_PREFERENCE,
  type LanguagePreference,
  SUPPORTED_LANGUAGES,
  type SupportedLanguage,
  getFollowSystemLanguageLabel,
  resolveLanguagePreference,
} from "@src/i18n";
import { NAV_BUTTON_PROPS } from "@src/modules/MainApp/Settings/config";
import { checkForUpdatesManually } from "@src/scaffold/AppUpdater";
import { type TimezoneOption, timezoneAtom } from "@src/store";
import { chatAppearancePersistAtom } from "@src/store/config/configAtom";
import { devModeEnabledAtom } from "@src/store/platform/devModeAtom";
import { preventSleepWhileRunningAtom } from "@src/store/platform/preventSleepAtom";
import { voiceInputEnabledAtom } from "@src/store/platform/voiceInputAtom";
import { languageAtom } from "@src/store/ui/languageAtom";
import { copyText } from "@src/util/data/clipboard";

export const GENERAL_TAB_KEYS = {
  GENERAL: "general",
  NOTIFICATIONS: "notifications",
  SHORTCUTS: "shortcuts",
} as const;

export type GeneralTabKey =
  (typeof GENERAL_TAB_KEYS)[keyof typeof GENERAL_TAB_KEYS];

const NotificationsTab = lazy(() => import("./NotificationsTab"));
const ShortcutsTab = lazy(() => import("./ShortcutsSection"));

interface GeneralSectionProps {
  activeTab?: string;
}

const GeneralSection: React.FC<GeneralSectionProps> = ({
  activeTab = GENERAL_TAB_KEYS.GENERAL,
}) => {
  if (activeTab === GENERAL_TAB_KEYS.NOTIFICATIONS) {
    return (
      <Suspense
        fallback={<Placeholder variant="loading" placement="detail-panel" />}
      >
        <NotificationsTab />
      </Suspense>
    );
  }

  if (activeTab === GENERAL_TAB_KEYS.SHORTCUTS) {
    return (
      <Suspense
        fallback={<Placeholder variant="loading" placement="detail-panel" />}
      >
        <ShortcutsTab />
      </Suspense>
    );
  }

  return <GeneralTabBody />;
};

const GeneralTabBody: React.FC = () => {
  const { t, i18n } = useTranslation("settings");
  const [timezone, setTimezone] = useAtom(timezoneAtom);
  const [chatAppearance, updateChatAppearance] = useAtom(
    chatAppearancePersistAtom
  );
  const [languagePreference, setLanguagePreference] = useAtom(languageAtom);
  const [settingsFilePath, setSettingsFilePath] = useState(
    "~/.orgii/settings.jsonc"
  );
  const timezoneSelectProps = useTimezoneSelect({
    value: timezone,
    onChange: (value) => setTimezone(value as TimezoneOption),
    style: SECTION_CONTROL_STYLE,
  });

  const [appVersion, setAppVersion] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    getVersion().then((v) => {
      if (!cancelled) setAppVersion(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const [devModeEnabled, setDevModeEnabled] = useAtom(devModeEnabledAtom);
  const [preventSleepWhileRunning, setPreventSleepWhileRunning] = useAtom(
    preventSleepWhileRunningAtom
  );
  const [voiceInputEnabled, setVoiceInputEnabled] = useAtom(
    voiceInputEnabledAtom
  );
  const [micPermissionStatus, setMicPermissionStatus] =
    useState<MicrophonePermissionStatus>("unknown");
  const [micPermissionRequesting, setMicPermissionRequesting] = useState(false);
  const canConfigureMic = useMemo(() => canOpenMicrophoneSystemSettings(), []);

  // Initial / on-mount status check — non-disruptive, never triggers the OS
  // prompt. Re-runs whenever the voice toggle is flipped on so the badge
  // reflects current state without the user having to click Request again.
  useEffect(() => {
    if (!voiceInputEnabled) return;
    let cancelled = false;
    checkMicrophonePermission().then((status) => {
      if (!cancelled) setMicPermissionStatus(status);
    });
    return () => {
      cancelled = true;
    };
  }, [voiceInputEnabled]);

  // The Permissions API doesn't fire change events reliably across
  // platforms, so we also recheck when the window regains focus — this
  // catches the common case where the user toggled access in System
  // Settings and tabbed back to ORGII.
  useEffect(() => {
    if (!voiceInputEnabled) return;
    const handleFocus = () => {
      checkMicrophonePermission().then(setMicPermissionStatus);
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [voiceInputEnabled]);

  const handleRequestMicPermission = useCallback(async () => {
    setMicPermissionRequesting(true);
    try {
      const status = await requestMicrophonePermission();
      setMicPermissionStatus(status);
      if (status === "granted") {
        Message.success(t("general.voiceInputPermissionGranted"));
      } else if (status === "denied") {
        Message.warning(t("general.voiceInputPermissionDenied"));
      } else if (status === "unsupported") {
        Message.error(t("general.voiceInputPermissionUnsupported"));
      }
    } finally {
      setMicPermissionRequesting(false);
    }
  }, [t]);

  const handleOpenMicSettings = useCallback(async () => {
    try {
      await openMicrophoneSystemSettings();
    } catch {
      Message.error(t("general.voiceInputPermissionOpenFailed"));
    }
  }, [t]);

  const micStatusBadge = useMemo(() => {
    switch (micPermissionStatus) {
      case "granted":
        return t("general.voiceInputPermissionStatusGranted");
      case "denied":
        return t("general.voiceInputPermissionStatusDenied");
      case "prompt":
        return t("general.voiceInputPermissionStatusNotRequested");
      case "unsupported":
        return t("general.voiceInputPermissionStatusUnsupported");
      default:
        return t("common:status.unknown");
    }
  }, [micPermissionStatus, t]);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("settings_get_path").then((path) => {
      if (!cancelled && path) {
        setSettingsFilePath(path);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleLanguageChange = useCallback(
    (value: string | number | (string | number)[]) => {
      const newPreference = String(value) as LanguagePreference;
      void i18n.changeLanguage(resolveLanguagePreference(newPreference));
      setLanguagePreference(newPreference);
    },
    [i18n, setLanguagePreference]
  );

  // Language options for the selector
  // Format: "Translated Name · Native Name" (e.g., in French: "Anglais · English")
  const languageOptions = useMemo(
    () => [
      {
        value: LANGUAGE_PREFERENCE.SYSTEM,
        label: getFollowSystemLanguageLabel(t("general.followSystem")),
      },
      ...SUPPORTED_LANGUAGES.map((lang) => {
        const translatedName = t(`general.languageNames.${lang}`);
        const nativeName = LANGUAGE_NAMES[lang];
        const displayLabel =
          translatedName === nativeName
            ? nativeName
            : `${translatedName} · ${nativeName}`;

        return {
          value: lang,
          label: displayLabel,
        };
      }),
    ],
    [t]
  );

  // Custom filter function to search languages by translated name, native name, and code
  const languageFilterOption = useCallback(
    (inputValue: string, option: { value: string | number }) => {
      const searchTerm = inputValue.toLowerCase();
      if (option.value === LANGUAGE_PREFERENCE.SYSTEM) {
        const systemLabel = getFollowSystemLanguageLabel(
          t("general.followSystem")
        ).toLowerCase();
        return systemLabel.includes(searchTerm);
      }

      const lang = option.value as SupportedLanguage;
      const translatedName =
        t(`general.languageNames.${lang}`)?.toLowerCase() || "";
      const nativeName = LANGUAGE_NAMES[lang]?.toLowerCase() || "";

      return (
        translatedName.includes(searchTerm) ||
        nativeName.includes(searchTerm) ||
        lang.includes(searchTerm)
      );
    },
    [t]
  );

  return (
    <>
      <SectionContainer>
        <SectionRow label={t("common:common.language")}>
          <Select
            value={languagePreference}
            onChange={handleLanguageChange}
            options={languageOptions}
            size="default"
            style={SECTION_CONTROL_STYLE}
            showSearch
            placeholder={t("general.languageSearchPlaceholder")}
            filterOption={languageFilterOption}
          />
        </SectionRow>
        <SectionRow label={t("common:common.timezone")}>
          <Select {...timezoneSelectProps} />
        </SectionRow>
      </SectionContainer>
      <SectionContainer>
        <SectionRow
          label={t("general.sendOnEnter")}
          description={t("general.sendOnEnterDesc")}
        >
          <Switch
            checked={chatAppearance.sendOnEnter}
            onChange={(checked) => {
              updateChatAppearance({ sendOnEnter: checked });
            }}
          />
        </SectionRow>
      </SectionContainer>
      <SectionContainer>
        <SectionRow label={t("general.voiceInput")}>
          <Switch checked={voiceInputEnabled} onChange={setVoiceInputEnabled} />
        </SectionRow>
        {voiceInputEnabled && (
          <SectionRow label={t("general.voiceInputPermission")} indent>
            <div className="flex items-center gap-2">
              <span className="whitespace-nowrap text-xs text-text-1">
                {micStatusBadge}
              </span>
              {micPermissionStatus !== "granted" &&
                micPermissionStatus !== "unsupported" && (
                  <Button
                    size="default"
                    loading={micPermissionRequesting}
                    onClick={handleRequestMicPermission}
                  >
                    {t("general.voiceInputPermissionAction")}
                  </Button>
                )}
              {canConfigureMic && (
                <Button {...NAV_BUTTON_PROPS} onClick={handleOpenMicSettings}>
                  {t("common:actions.configure")}
                </Button>
              )}
            </div>
          </SectionRow>
        )}
      </SectionContainer>

      <SectionContainer>
        <SectionRow
          label={t("general.preventSleep")}
          description={t("general.preventSleepDesc")}
        >
          <Switch
            checked={preventSleepWhileRunning}
            onChange={setPreventSleepWhileRunning}
          />
        </SectionRow>
        <SectionRow
          label={t("general.devMode")}
          description={t("general.devModeDesc")}
        >
          <Switch checked={devModeEnabled} onChange={setDevModeEnabled} />
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <SectionRow label={t("update.detectUpdate")}>
          <Button
            size="default"
            onClick={checkForUpdatesManually}
            icon={<RefreshCw size={14} />}
          >
            {t("update.detectUpdate")}
          </Button>
        </SectionRow>
        <SectionRow label={t("update.currentVersion")}>
          <span className={SECTION_VALUE_TEXT_CLASSES}>
            {appVersion ? `v${appVersion}` : "—"}
          </span>
        </SectionRow>
      </SectionContainer>

      <SectionContainer>
        <PathCopyOpenRow
          label={t("general.settingsFile")}
          path={settingsFilePath}
          onCopy={() => {
            void copyText(settingsFilePath).then(() => {
              Message.success(t("storage.copiedPath"));
            });
          }}
          onOpen={() => invoke("show_in_folder", { path: settingsFilePath })}
          copyTitle={t("common:actions.copy")}
          openTitle={t("storage.openFolder")}
        />
      </SectionContainer>
    </>
  );
};

export default GeneralSection;
