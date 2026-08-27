import { atomWithStorage } from "jotai/utils";

import type { CliAgentType } from "@src/api/types/keys";

export const CLI_UPDATE_ALERT_SNOOZE_MS = 6 * 60 * 60 * 1000;

export interface CliUpdateAlertSuppression {
  mutedLatestVersion?: string;
  snoozedUntil?: number;
}

export type CliUpdateAlertSuppressions = Partial<
  Record<CliAgentType, CliUpdateAlertSuppression>
>;

export const cliUpdateAlertsEnabledAtom = atomWithStorage<boolean>(
  "orgii:cliUpdateAlerts:enabled",
  true,
  undefined,
  { getOnInit: true }
);
cliUpdateAlertsEnabledAtom.debugLabel = "cliUpdateAlertsEnabledAtom";

export const cliUpdateAlertSuppressionsAtom =
  atomWithStorage<CliUpdateAlertSuppressions>(
    "orgii:cliUpdateAlerts:suppressions",
    {},
    undefined,
    { getOnInit: true }
  );
cliUpdateAlertSuppressionsAtom.debugLabel = "cliUpdateAlertSuppressionsAtom";

export function isCliUpdateAlertSuppressed(
  suppression: CliUpdateAlertSuppression | undefined,
  latestVersion: string | null | undefined,
  now: number
): boolean {
  if ((suppression?.snoozedUntil ?? 0) > now) return true;
  return Boolean(
    latestVersion && suppression?.mutedLatestVersion === latestVersion
  );
}
