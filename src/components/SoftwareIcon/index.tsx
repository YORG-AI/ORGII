/**
 * SoftwareIcon Component
 *
 * Displays the appropriate icon for IDEs, editors, and CLI tools.
 * Accepts either an id (matching server_detect_ides) or a display name
 * (matching DependencyStatus.name) and resolves to the correct SVG.
 *
 * Falls back to Lucide Monitor for unrecognized software.
 *
 * @example
 * ```tsx
 * <SoftwareIcon type="cursor" size={16} />
 * <SoftwareIcon type="Visual Studio Code" size={14} />
 * ```
 */
import { Bot, Monitor } from "lucide-react";
import React, { memo } from "react";

import {
  SOFTWARE_ICON_MAP,
  SOFTWARE_NAME_TO_ID,
  type SoftwareType,
} from "./config";

export type { SoftwareType } from "./config";
export { SOFTWARE_NAME_TO_ID } from "./config";

export interface SoftwareIconProps {
  /** Software id (e.g. "cursor") or display name (e.g. "Cursor") */
  type: string;
  /** Icon size in pixels (default: 16) */
  size?: number;
  /** Additional className */
  className?: string;
}

const AI_CLI_IDS = new Set<string>(["claude", "codex"]);

const SoftwareIcon: React.FC<SoftwareIconProps> = memo(
  ({ type, size = 16, className = "" }) => {
    const resolvedId = (SOFTWARE_NAME_TO_ID[type] ?? type) as SoftwareType;

    const Icon = SOFTWARE_ICON_MAP[resolvedId];
    if (Icon) {
      return <Icon width={size} height={size} className={className} />;
    }

    if (AI_CLI_IDS.has(resolvedId)) {
      return <Bot size={size} className={className} />;
    }

    return <Monitor size={size} className={className} />;
  }
);

SoftwareIcon.displayName = "SoftwareIcon";

export default SoftwareIcon;
