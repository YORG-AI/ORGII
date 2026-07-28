import React from "react";

import TabPill, { type TabPillItem } from "@src/components/TabPill";

export interface OrganizationTabSwitchProps {
  tabs: TabPillItem[];
  activeTab: string;
  onChange: (key: string) => void;
  className?: string;
  size?: "small" | "large";
}

/** Shared visual contract for cloud and local organization navigation. */
export const OrganizationTabSwitch: React.FC<OrganizationTabSwitchProps> = ({
  tabs,
  activeTab,
  onChange,
  className,
  size = "large",
}) => (
  <TabPill
    tabs={tabs}
    activeTab={activeTab}
    onChange={onChange}
    variant="simple"
    color="default"
    fillWidth={false}
    size={size}
    className={className}
  />
);

export default OrganizationTabSwitch;
