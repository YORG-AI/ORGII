import React from "react";

import { KeyboardShortcutTooltipContent } from "@src/components/KeyboardShortcut";
import { getShortcutKeys } from "@src/config/keyboard/shortcutDisplay";

export function SidebarSearchShortcutTooltip({
  searchLabel,
}: {
  searchLabel: string;
}): React.ReactElement {
  return (
    <KeyboardShortcutTooltipContent
      rows={[
        { label: "Spotlight", shortcut: getShortcutKeys("spotlight_open") },
        {
          label: `${searchLabel} session`,
          shortcut: getShortcutKeys("agent_session_search"),
        },
      ]}
    />
  );
}
