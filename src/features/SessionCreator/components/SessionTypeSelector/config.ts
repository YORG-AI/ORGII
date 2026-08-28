import { FlashIcon } from "@src/icons";

import {
  AGENT_EXEC_MODES,
  DEFAULT_AGENT_EXEC_MODE as _DEFAULT_AGENT_EXEC_MODE,
} from "../../config";

/**
 * Session Type Configuration
 *
 * Agent exec mode options for ControlButtons pill.
 * Derived from single source of truth in SessionCreator/config.ts
 */

export interface SessionTypeOption {
  id: string;
  name: string;
  description: string;
  icon: typeof FlashIcon;
}

export const AGENT_EXEC_MODE_OPTIONS: SessionTypeOption[] =
  AGENT_EXEC_MODES.map((mode) => ({
    id: mode.id,
    name: mode.name,
    description: mode.description,
    icon: mode.icon,
  }));

export const DEFAULT_AGENT_EXEC_MODE = _DEFAULT_AGENT_EXEC_MODE;

export function getAgentExecModeOption(id: string): SessionTypeOption {
  return (
    AGENT_EXEC_MODE_OPTIONS.find((opt) => opt.id === id) ||
    AGENT_EXEC_MODE_OPTIONS[0]
  );
}
