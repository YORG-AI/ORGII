import React from "react";

import ModelIcon, { type IconProvider } from "@src/components/ModelIcon";
import { ComputerTerminal01Icon, HugeiconsIcon } from "@src/icons";

interface SessionProvenanceSourceIconProps {
  iconId: IconProvider;
}

const SessionProvenanceSourceIcon: React.FC<
  SessionProvenanceSourceIconProps
> = ({ iconId }) => (
  <ModelIcon
    provider={iconId}
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

export default SessionProvenanceSourceIcon;
