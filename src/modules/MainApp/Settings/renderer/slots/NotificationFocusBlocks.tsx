import {
  SectionContainer,
  SectionRow,
} from "@/src/modules/shared/layouts/SectionLayout";
import React from "react";
import { useTranslation } from "react-i18next";

import Switch from "@src/components/Switch";
import TimePicker from "@src/components/TimePicker";
import { useSetting } from "@src/store/settings";

function splitClockTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(":").map(Number);
  return { hour, minute };
}

function formatClockTime(hour: number, minute: number): string {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

const NotificationFocusBlocks: React.FC = () => {
  const { t } = useTranslation("settings");
  const [criticalOnly, setCriticalOnly] = useSetting(
    "notifications.criticalOnly"
  );
  const [quietHoursEnabled, setQuietHoursEnabled] = useSetting(
    "notifications.quietHours.enabled"
  );
  const [quietHoursStart, setQuietHoursStart] = useSetting(
    "notifications.quietHours.start"
  );
  const [quietHoursEnd, setQuietHoursEnd] = useSetting(
    "notifications.quietHours.end"
  );
  const [allowCritical, setAllowCritical] = useSetting(
    "notifications.quietHours.allowCritical"
  );
  const [backgroundSummary, setBackgroundSummary] = useSetting(
    "notifications.backgroundCompletionSummary"
  );

  const start = splitClockTime(quietHoursStart);
  const end = splitClockTime(quietHoursEnd);

  return (
    <>
      <SectionContainer>
        <SectionRow
          label={t("notifications.criticalOnly")}
          description={t("notifications.criticalOnlyDesc")}
        >
          <Switch
            checked={criticalOnly}
            onCheckedChange={() => setCriticalOnly(!criticalOnly)}
            ariaLabel={t("notifications.criticalOnly")}
          />
        </SectionRow>
        <SectionRow
          label={t("notifications.quietHours")}
          description={t("notifications.quietHoursDesc")}
        >
          <Switch
            checked={quietHoursEnabled}
            onCheckedChange={() => setQuietHoursEnabled(!quietHoursEnabled)}
            ariaLabel={t("notifications.quietHours")}
          />
        </SectionRow>
        {quietHoursEnabled && (
          <>
            <SectionRow
              label={t("notifications.quietHoursSchedule")}
              description={t("notifications.quietHoursScheduleDesc")}
              indent
            >
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-1.5 text-xs text-text-2">
                  <span>{t("notifications.quietHoursStart")}</span>
                  <TimePicker
                    hour={start.hour}
                    minute={start.minute}
                    onChange={(hour, minute) =>
                      setQuietHoursStart(formatClockTime(hour, minute))
                    }
                    className="w-24"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-xs text-text-2">
                  <span>{t("notifications.quietHoursEnd")}</span>
                  <TimePicker
                    hour={end.hour}
                    minute={end.minute}
                    onChange={(hour, minute) =>
                      setQuietHoursEnd(formatClockTime(hour, minute))
                    }
                    className="w-24"
                  />
                </label>
              </div>
            </SectionRow>
            <SectionRow
              label={t("notifications.allowCriticalDuringQuietHours")}
              description={t("notifications.allowCriticalDuringQuietHoursDesc")}
              indent
            >
              <Switch
                checked={allowCritical}
                onCheckedChange={() => setAllowCritical(!allowCritical)}
                ariaLabel={t("notifications.allowCriticalDuringQuietHours")}
              />
            </SectionRow>
            <SectionRow
              label={t("notifications.backgroundCompletionSummary")}
              description={t("notifications.backgroundCompletionSummaryDesc")}
              indent
            >
              <Switch
                checked={backgroundSummary}
                onCheckedChange={() => setBackgroundSummary(!backgroundSummary)}
                ariaLabel={t("notifications.backgroundCompletionSummary")}
              />
            </SectionRow>
          </>
        )}
      </SectionContainer>
    </>
  );
};

export default NotificationFocusBlocks;
