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
    <nav
      className="flex shrink-0 border-t border-border-2 bg-bg-1 pb-[max(8px,env(safe-area-inset-bottom))]"
      aria-label="Mobile remote tabs"
    >
      {tabs.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Button
            key={tab.id}
            htmlType="button"
            variant="tertiary"
            appearance="ghost"
            className={`min-h-[49px] flex-1 flex-col gap-1.5 rounded-none px-1 py-1.5 ${
              isActive ? "text-text-1" : "text-text-3"
            }`}
            style={{ height: "auto", minHeight: 49, padding: "6px 4px" }}
            onClick={() => onChange?.(tab.id)}
            aria-current={isActive ? "page" : undefined}
          >
            <HugeiconsIcon icon={tab.icon} size={22} />
            <span className="text-xs leading-none">{tab.label}</span>
          </Button>
        );
      })}
    </nav>
  );
}

MobileTabBar.displayName = "MobileTabBar";
