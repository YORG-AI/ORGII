/**
 * Security Settings Section
 *
 * Composer secret scanning: warn before API keys / tokens / passwords are
 * sent to the model, with optional high-entropy detection and user-defined
 * custom regex patterns. The scan logic lives in `@src/util/secretScan`;
 * this section only renders the toggles + pattern editor.
 *
 * Returns content only — the Settings page shell renders the section title
 * (as the tab pill) and wraps this in the scroll container.
 */
import React, { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import Switch from "@src/components/Switch";
import { useSetting } from "@src/hooks/settings/useSettings";
import SaveableTextarea from "@src/modules/shared/components/SaveableTextarea";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { validateCustomPatterns } from "@src/util/secretScan";

const SecuritySection: React.FC = () => {
  const { t } = useTranslation("settings");

  const [secretScanEnabled, setSecretScanEnabled] = useSetting(
    "general.secretScanEnabled"
  );
  const [secretScanEntropy, setSecretScanEntropy] = useSetting(
    "general.secretScanEntropyEnabled"
  );
  const [customPatterns, setCustomPatterns] = useSetting(
    "general.secretScanCustomPatterns"
  );

  const handleSaveCustomPatterns = useCallback(
    (val: string) => {
      setCustomPatterns(
        val
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
      );
    },
    [setCustomPatterns]
  );

  const invalidPatternWarning = useMemo(() => {
    const invalid = validateCustomPatterns(customPatterns);
    if (invalid.length === 0) return null;
    return t("security.invalidPatterns", {
      count: invalid.length,
      patterns: invalid.map((entry) => entry.pattern).join(", "),
    });
  }, [customPatterns, t]);

  return (
    <SectionContainer>
      <SectionRow
        label={t("security.scan")}
        description={t("security.scanDesc")}
      >
        <Switch
          checked={secretScanEnabled}
          onCheckedChange={setSecretScanEnabled}
        />
      </SectionRow>
      {secretScanEnabled && (
        <>
          <SectionRow
            label={t("security.entropy")}
            description={t("security.entropyDesc")}
            indent
          >
            <Switch
              checked={secretScanEntropy}
              onCheckedChange={setSecretScanEntropy}
            />
          </SectionRow>
          <SectionRow
            label={t("security.customPatterns")}
            description={t("security.customPatternsDesc")}
            layout="vertical"
            indent
          >
            <div className="flex flex-col gap-2">
              <SaveableTextarea
                value={customPatterns.join("\n")}
                onSave={handleSaveCustomPatterns}
                placeholder={t("security.customPatternsPlaceholder")}
                autoSize={{ minRows: 2, maxRows: 8 }}
              />
              {invalidPatternWarning && (
                <span className="text-xs text-danger-6">
                  {invalidPatternWarning}
                </span>
              )}
            </div>
          </SectionRow>
        </>
      )}
    </SectionContainer>
  );
};

export default SecuritySection;
