import React from "react";

import Switch from "@src/components/Switch";
import { useSetting } from "@src/store/settings";

const NotificationsMasterToggleRow: React.FC = () => {
  const [enabled, setEnabled] = useSetting("notifications.enabled");

  return <Switch checked={enabled} onChange={() => setEnabled(!enabled)} />;
};

export default NotificationsMasterToggleRow;
