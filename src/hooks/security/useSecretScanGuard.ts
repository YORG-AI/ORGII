/**
 * useSecretScanGuard
 *
 * Returns a guard callback that scans outgoing composer text for secrets
 * (API keys, tokens, passwords) and, if any are found, pops a native
 * confirmation dialog before the message is sent. The user can still choose
 * "Send anyway".
 *
 * Wired into both submit paths (session creator launch + follow-up send) so
 * the check is uniform. Mirrors the shape of `confirmShortInputIfNeeded`:
 * returns `true` to proceed, `false` to abort the send.
 *
 * The scan itself lives in `@src/util/secretScan` (pure). This hook only
 * reads the relevant settings and renders the confirmation UI.
 */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";

import { useSettingValue } from "@src/hooks/settings/useSettings";
import { askNativeDialogSafely } from "@src/util/dialogs/nativeDialog";
import { scanForSecrets } from "@src/util/secretScan";

export function useSecretScanGuard(): (text: string) => Promise<boolean> {
  const { t } = useTranslation("common");
  const enabled = useSettingValue("general.secretScanEnabled");
  const entropy = useSettingValue("general.secretScanEntropyEnabled");
  const customPatterns = useSettingValue("general.secretScanCustomPatterns");

  return useCallback(
    async (text: string): Promise<boolean> => {
      if (!enabled || !text.trim()) return true;

      const matches = scanForSecrets(text, {
        entropy,
        customPatterns,
      });
      if (matches.length === 0) return true;

      const items = matches
        .map((match) => `• ${match.label} (${match.masked})`)
        .join("\n");
      const message = t("secretScan.message", { items });

      try {
        return await askNativeDialogSafely(message, {
          title: t("secretScan.title"),
          kind: "warning",
          okLabel: t("secretScan.sendAnyway"),
          cancelLabel: t("actions.cancel"),
        });
      } catch {
        return window.confirm(message);
      }
    },
    [enabled, entropy, customPatterns, t]
  );
}
