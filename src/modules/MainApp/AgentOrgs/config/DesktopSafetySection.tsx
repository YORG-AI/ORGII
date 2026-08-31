/**
 * DesktopSafetySection — fine-grained sub-gates for the desktop automation
 * stack. Each toggle corresponds to a field in the Rust-side DesktopConfig
 * struct; changes persist to ~/.orgii/data/desktop_config.json via
 * `agent_set_desktop_config`.
 */
import React, { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  type DesktopConfig,
  getDesktopConfig,
  setDesktopConfig,
} from "@src/api/tauri/agent";
import Switch from "@src/components/Switch";
import {
  SectionContainer,
  SectionRow,
} from "@src/modules/shared/layouts/SectionLayout";
import { CollapsibleSection } from "@src/modules/shared/layouts/blocks";

type Gate = {
  key: keyof DesktopConfig;
  labelKey: string;
  helperKey: string;
};

const GATES: Gate[] = [
  {
    key: "hideBeforeAction",
    labelKey: "osAgent.desktopConfig.hideBeforeAction",
    helperKey: "osAgent.desktopConfig.hideBeforeActionHelper",
  },
  {
    key: "antiDetection",
    labelKey: "osAgent.desktopConfig.antiDetection",
    helperKey: "osAgent.desktopConfig.antiDetectionHelper",
  },
  {
    key: "humanInputProfile",
    labelKey: "osAgent.desktopConfig.humanInputProfile",
    helperKey: "osAgent.desktopConfig.humanInputProfileHelper",
  },
  {
    key: "escapeAbort",
    labelKey: "osAgent.desktopConfig.escapeAbort",
    helperKey: "osAgent.desktopConfig.escapeAbortHelper",
  },
];

const DEFAULTS: DesktopConfig = {
  hideBeforeAction: true,
  antiDetection: true,
  humanInputProfile: true,
  escapeAbort: true,
};

const DesktopSafetySection: React.FC = () => {
  const { t } = useTranslation("settings");
  const [config, setConfig] = useState<DesktopConfig>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let alive = true;
    getDesktopConfig()
      .then((c) => {
        if (alive) {
          setConfig(c);
          setLoaded(true);
        }
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const toggle = useCallback(
    async (key: keyof DesktopConfig, value: boolean) => {
      const next: DesktopConfig = { ...config, [key]: value };
      setConfig(next);
      try {
        await setDesktopConfig(next);
      } catch {
        setConfig(config);
      }
    },
    [config]
  );

  return (
    <CollapsibleSection title={t("osAgent.desktopConfig.title")}>
      <SectionContainer>
        {GATES.map((gate) => (
          <SectionRow key={gate.key} label={t(gate.labelKey)} layout="vertical">
            <div className="flex items-start justify-between gap-4">
              <span className="text-xs text-text-3">{t(gate.helperKey)}</span>
              <Switch
                checked={config[gate.key]}
                disabled={!loaded}
                dataTestId={`agent-orgs-desktop-safety-${gate.key}-switch`}
                onCheckedChange={(v) => toggle(gate.key, v)}
              />
            </div>
          </SectionRow>
        ))}
      </SectionContainer>
    </CollapsibleSection>
  );
};

export default DesktopSafetySection;
