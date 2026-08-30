/**
 * RuntimeScanningPanelSourceIcon
 *
 * Icon-with-fallback used in RuntimeScanningPanel's "source" column: the
 * detected app/CLI's model icon, or a generic terminal glyph when none is
 * registered.
 */
import React from "react";

import type { ExternalCliSourceProbe } from "@src/api/tauri/externalHistory";
import ModelIcon, { type IconProvider } from "@src/components/ModelIcon";
import { ComputerTerminal01Icon, HugeiconsIcon } from "@src/icons";

const RuntimeScanningPanelSourceIcon: React.FC<{
  probe: ExternalCliSourceProbe;
}> = ({ probe }) => (
  <ModelIcon
    provider={probe.iconId as IconProvider}
    size={16}
    fallback={
      <HugeiconsIcon
        icon={ComputerTerminal01Icon}
        data-icon="terminal"
        size={16}
        className="text-text-3"
      />
    }
  />
);

export default RuntimeScanningPanelSourceIcon;
