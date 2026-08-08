/**
 * chatPanelTerminalTabLookup
 *
 * Pure lookup extracted from `useChatPanelTabsController` so the "is this
 * CLI launch already open in a terminal tab?" decision is unit-testable
 * without pulling in Jotai atoms or React.
 *
 * A chat-panel terminal tab (`ChatPanelTab`, keyed by `terminalSessionId`)
 * and the PTY session it drives (`TerminalSession`, in the shared terminal
 * atom store) are two different records. The backend mints a brand-new
 * managed `code_sessions` row (and therefore a new `agentSessionId`) on
 * every `cli_agent_create` call, so a repeat "Continue in <CLI>" click
 * can't be recognized by comparing session ids. What *is* stable across
 * repeat clicks for the same resume target is the fully-resolved command
 * line — for an imported-session resume it already carries the
 * resume-specific args (`--resume <uuid>`, `--session <path>`, …), and for
 * a fresh CLI TUI launch it's the resolved launch-profile command. Two
 * launches with the same agent, the same resolved command, and the same
 * cwd are the same target.
 */
import type { TerminalSession } from "@src/engines/TerminalCore/types";
import type { ChatPanelTab } from "@src/store/chatPanel/chatPanelTabsAtom";

export interface CliTerminalLaunchTarget {
  cliAgentType?: TerminalSession["cliAgentType"];
  command: string;
  cwd?: string;
}

/**
 * Find an already-open chat-panel terminal tab whose backing PTY session
 * was launched with the same CLI agent, resolved command, and cwd as
 * `target`. Returns `undefined` when there's no match (including when the
 * new launch has no resolved command to compare against).
 */
export function findOpenCliTerminalTab(
  tabs: readonly ChatPanelTab[],
  terminalSessions: readonly TerminalSession[],
  target: CliTerminalLaunchTarget
): ChatPanelTab | undefined {
  if (!target.command.trim()) return undefined;

  return tabs.find((tab) => {
    if (tab.type !== "terminal" || !tab.terminalSessionId) return false;
    const session = terminalSessions.find(
      (candidate) => candidate.id === tab.terminalSessionId
    );
    if (!session || !session.agentCommand) return false;
    return (
      session.cliAgentType === target.cliAgentType &&
      session.agentCommand === target.command &&
      (session.cwd ?? undefined) === (target.cwd ?? undefined)
    );
  });
}
