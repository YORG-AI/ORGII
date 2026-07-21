import React from "react";

import { NoDragRegion } from "@src/components/WindowChrome";

import { StationModeChip } from "./StationModeChip";
import { TabBarLeadingLayout } from "./TabBarLeadingLayout";

interface StationTabBarLeadingProps {
  trailing?: React.ReactNode;
}

export const StationTabBarLeading: React.FC<StationTabBarLeadingProps> = ({
  trailing,
}) => (
  <TabBarLeadingLayout>
    <NoDragRegion>
      <StationModeChip />
    </NoDragRegion>
    {trailing ? <NoDragRegion>{trailing}</NoDragRegion> : null}
  </TabBarLeadingLayout>
);

export default StationTabBarLeading;
