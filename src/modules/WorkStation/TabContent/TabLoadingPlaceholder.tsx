import React, { memo } from "react";

import { Placeholder } from "@src/components/Placeholder";

export const TabLoadingPlaceholder: React.FC = memo(() => (
  <Placeholder variant="loading" placement="detail-panel" fillParentHeight />
));

TabLoadingPlaceholder.displayName = "TabLoadingPlaceholder";

export default TabLoadingPlaceholder;
