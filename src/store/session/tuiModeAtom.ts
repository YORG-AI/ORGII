/**
 * TUI Mode Atom
 *
 * Per-session flag that forces all shell/terminal blocks to render through
 * xterm.js instead of ansi-to-react. Persisted to localStorage so the
 * preference survives navigation and page refresh.
 *
 * Auto-detection (hasTuiSequences) still runs when this is false —
 * individual blocks that emit cursor-movement sequences are upgraded
 * automatically regardless of this setting.
 */
import { atomFamily } from "jotai-family";
import { atomWithStorage } from "jotai/utils";

export const tuiModeAtom = atomFamily((sessionId: string) =>
  atomWithStorage<boolean>(`orgii:tuiMode:${sessionId}`, false)
);
