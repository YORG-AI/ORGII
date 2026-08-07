/**
 * Status presets for the DevTools Single Event Playground.
 *
 * Preset data is organized by domain in presets/:
 *   - presets/specialAgentTools.ts  — approval_request, suggest_mode_switch
 *   - presets/specialFileTools.ts   — edit_file, apply_patch
 *   - presets/specialAwaitTools.ts  — await_output, await_output_subagent, await_output_multi, await_output_list
 *   - presets/commandReadFile.ts    — read_file command variants (text, image, pdf)
 *   - presets/commandCodeSearch.ts  — code_search command variants (grep, find_files, glob, symbols, check_status)
 *   - presets/commandWorktree.ts    — worktree command variants (add, leave, list)
 *   - presets/commandRunShell.ts    — run_shell command variants (run, kill)
 */
import { SUBAGENT_PLAYGROUND_PRESETS } from "@src/modules/MainApp/ToolPreview/mockData";

import { DEFAULT_PLAYGROUND_STATUS_PRESETS, type StatusPreset } from "../types";
import { commandCodeSearchPresets } from "./presets/commandCodeSearch";
import { commandReadFilePresets } from "./presets/commandReadFile";
import { commandRunShellPresets } from "./presets/commandRunShell";
import { commandWorktreePresets } from "./presets/commandWorktree";
import { specialAgentToolPresets } from "./presets/specialAgentTools";
import { specialAwaitToolPresets } from "./presets/specialAwaitTools";
import { specialFileToolPresets } from "./presets/specialFileTools";

export type { StatusPreset } from "../types";

export const DEFAULT_STATUS_PRESETS: StatusPreset[] =
  DEFAULT_PLAYGROUND_STATUS_PRESETS;

export const SPECIAL_STATUS_PRESETS: Record<string, StatusPreset[]> = {
  ...specialAgentToolPresets,
  ...specialFileToolPresets,
  ...specialAwaitToolPresets,
};

// Per-command status presets. Keyed by `[toolName][commandName]`. When a tool's
// commands have meaningfully different lifecycles (e.g. run vs kill, wait vs
// list), put their preset lists here instead of inside SPECIAL_STATUS_PRESETS.
//
// Resolution order (see resolveStatusPresets below):
//   1. COMMAND_STATUS_PRESETS[tool][command]
//   2. COMMAND_STATUS_PRESETS[tool] -> first command's list
//   3. SPECIAL_STATUS_PRESETS[tool]
//   4. DEFAULT_STATUS_PRESETS
export const COMMAND_STATUS_PRESETS: Record<
  string,
  Record<string, StatusPreset[]>
> = {
  read_file: commandReadFilePresets,
  code_search: commandCodeSearchPresets,
  worktree: commandWorktreePresets,
  run_shell: commandRunShellPresets,
};

/**
 * Pick the right preset list for the (tool, command) pair.
 *
 * Tool name should already be the UI canonical (callers can map registry
 * names with `getCliUiCanonical` before calling).
 */
export function resolveStatusPresets(
  toolName: string,
  command?: string
): StatusPreset[] {
  const commandTable = COMMAND_STATUS_PRESETS[toolName];
  if (commandTable) {
    if (command && commandTable[command]) return commandTable[command];
    const firstKey = Object.keys(commandTable)[0];
    if (firstKey) return commandTable[firstKey];
  }
  const special = SPECIAL_STATUS_PRESETS[toolName];
  if (special) return special;
  return DEFAULT_STATUS_PRESETS;
}

export function subagentSidebarStatusPresets(): StatusPreset[] {
  return SUBAGENT_PLAYGROUND_PRESETS.map((preset) => ({
    key: preset.key,
    label: preset.label,
    status: preset.status,
  }));
}
