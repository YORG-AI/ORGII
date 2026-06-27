/**
 * Shared display helpers for session rows (sidebar, chat history panel, etc.).
 */
import { FlaskConical, type LucideIcon } from "lucide-react";

import type { CliAgentType } from "@src/api/types/keys";
import { getIconProvider } from "@src/components/ModelIcon/config";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { resolveSessionIconId } from "@src/util/session/sessionDispatch";
import { sessionLabel } from "@src/util/session/sessionLabel";

/** Full-length session display name (no truncation). */
export function getSessionListDisplayName(
  session: { name?: string; user_input?: string },
  fallback: string
): string {
  return sessionLabel(session, Infinity) || fallback;
}

type SessionRowIconInput =
  | string
  | {
      session_id: string;
      user_input?: string;
      agentIconId?: string;
      cliAgentType?: CliAgentType;
    };

/**
 * Resolve the icon to render in a session list row.
 *
 * Resolution priority (most specific → most generic):
 *
 *  1. **`cliAgentType`** → brand icon via `getIconProvider`. Covers all
 *     CLI sessions (Cursor CLI, Claude Code, Codex, Gemini, Copilot,
 *     Kiro, Kimi, OpenCode, Qwen) and prevents stale `agentIconId` values
 *     from overriding the CLI provider identity.
 *  2. **`agentIconId`** — explicit per-session brand assignment. Used by
 *     Rust agent definitions (built-in + custom), where the definition
 *     carries an `iconId`.
 *  3. **Prefix-based** fallback (`resolveSessionIconId`) — last resort
 *     for sessions where neither of the above applies. Maps prefix →
 *     generic Lucide slug (e.g. `cursoride-` → `cursor`, `osagent-` →
 *     `omega`). Also the only path available for the string-only
 *     callsite that doesn't pass a full `Session` record.
 *
 * `getIconProvider` returns `"unknown"` for unrecognized CLI types,
 * which `resolveAgentIcon` then treats as a miss → falls back to `Bot`.
 * That keeps "I literally don't know what this is" honest rather than
 * silently mis-branding it as something it isn't.
 */
export function resolveSessionRowIcon(input: SessionRowIconInput): LucideIcon {
  if (typeof input !== "string") {
    if (input.user_input?.startsWith("Benchmark run coordinator")) {
      return FlaskConical;
    }
    if (input.cliAgentType) {
      return resolveAgentIcon(getIconProvider(input.cliAgentType));
    }
    if (input.agentIconId) {
      return resolveAgentIcon(input.agentIconId);
    }
  }

  const sessionId = typeof input === "string" ? input : input.session_id;
  return resolveAgentIcon(resolveSessionIconId(sessionId));
}
