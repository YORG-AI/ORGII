import React, { useMemo } from "react";
import { useTranslation } from "react-i18next";

import Button from "@src/components/Button";
import {
  BubbleChatIcon,
  HugeiconsIcon,
  Settings01Icon,
  SmartPhone01Icon,
} from "@src/icons";

import type { MobileRemoteTab } from "../navigation/mobileRemoteNavigation";

export type { MobileRemoteTab };

export interface MobileTabBarProps {
  active: MobileRemoteTab;
  onChange?: (tab: MobileRemoteTab) => void;
}

export function MobileTabBar({ active, onChange }: MobileTabBarProps) {
  const { t } = useTranslation("mobileRemote");

  const tabs = useMemo(
    () =>
      [
        {
          id: "sessions" as const,
          label: t("tabs.sessions"),
          icon: BubbleChatIcon,
        },
        {
          id: "devices" as const,
          label: t("tabs.devices"),
          icon: SmartPhone01Icon,
        },
        {
          id: "settings" as const,
          label: t("tabs.settings"),
          icon: Settings01Icon,
        },
      ] as const,
    [t]
  );

  return (
    <nav className="mobile-tab-dock" aria-label="Mobile remote tabs">
      <div className="mobile-tab-bar">
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          return (
            <Button
              key={tab.id}
              htmlType="button"
              variant="tertiary"
              appearance="ghost"
              shape="round"
              className="mobile-tab-button"
              style={{
                height: "auto",
                minHeight: "var(--mobile-tab-height)",
                padding: "var(--mobile-tab-padding)",
              }}
              onClick={() => onChange?.(tab.id)}
              aria-current={isActive ? "page" : undefined}
            >
              <span className="mobile-tab-button__content">
                <HugeiconsIcon icon={tab.icon} size={24} aria-hidden="true" />
                <span className="mobile-tab-button__label">{tab.label}</span>
              </span>
            </Button>
          );
        })}
      </div>
    </nav>
  );
}

MobileTabBar.displayName = "MobileTabBar";
