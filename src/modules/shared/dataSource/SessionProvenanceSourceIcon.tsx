import { Terminal } from "lucide-react";
import React from "react";

import ModelIcon, { type IconProvider } from "@src/components/ModelIcon";

interface SessionProvenanceSourceIconProps {
  iconId: IconProvider;
}

const SessionProvenanceSourceIcon: React.FC<
  SessionProvenanceSourceIconProps
> = ({ iconId }) => (
  <ModelIcon
    provider={iconId}
    size={16}
    fallback={<Terminal size={16} className="text-text-3" />}
  />
);

export default SessionProvenanceSourceIcon;
