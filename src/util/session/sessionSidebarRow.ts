/**
 * Shared display helpers for session rows (sidebar, chat history panel, etc.).
 */
import { FlaskConical, type LucideIcon } from "lucide-react";

import { IMPORTED_HISTORY_SOURCE_DESCRIPTORS } from "@src/api/tauri/externalHistory/imported/descriptors";
import type { CliAgentType } from "@src/api/types/keys";
import {
  THEMEABLE_ICONS,
  getIconProvider,
  getIconProviderFromType,
} from "@src/components/ModelIcon/config";
import { resolveAgentIcon } from "@src/config/agentIcons";
import { resolveSessionIconId } from "@src/util/session/sessionDispatch";
import { sessionLabel } from "@src/util/session/sessionLabel";

/** Full-length session display name (no truncation). */
export function getSessionListDisplayName(
  session: { name?: string; user_input?: string; displayLabel?: string },
  fallback: string
): string {
  return sessionLabel(session, Infinity) || fallback;
}

type SessionRowIconInput =
  | string
  | {
      session_id: string;
      user_input?: string;
      agentOrgId?: string;
      agentIconId?: string;
      cliAgentType?: CliAgentType;
      importedFrom?: {
        externalHistorySource?: string;
      };
    };

/**
 * Resolve the icon to render in a session list row.
 *
 * Resolution priority (most specific → most generic):
 *
 *  1. **`agentOrgId`** → Agent Org icon. Org-run sessions keep the org
 *     identity even when their coordinator uses a specific CLI/provider.
 *  2. **`cliAgentType`** → brand icon via `getIconProvider`. Covers all
 *     CLI sessions (Cursor CLI, Claude Code, Codex, Gemini, Copilot,
 *     Kiro, Kimi, OpenCode, Qwen) and prevents stale `agentIconId` values
 *     from overriding the CLI provider identity.
 *  3. **Collaboration import provenance** — preserves the source brand for
 *     imported external-app history and uses the ORGII session mark for a
 *     native org replay. This intentionally wins over the importer's legacy
 *     `agentIconId: "archive"` marker, which is not a registered icon.
 *  4. **`agentIconId`** — explicit per-session brand assignment. Used by
 *     Rust agent definitions (built-in + custom), where the definition
 *     carries an `iconId`.
 *  5. **Prefix-based** fallback (`resolveSessionIconId`) — last resort
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
  return resolveSessionRowIconPresentation(input).Icon;
}

export interface SessionRowIconPresentation {
  Icon: LucideIcon;
  isMonochromeBrandIcon: boolean;
}

/** Resolve the icon together with the color behavior of provider brand marks. */
export function resolveSessionRowIconPresentation(
  input: SessionRowIconInput
): SessionRowIconPresentation {
  if (typeof input !== "string") {
    if (input.user_input?.startsWith("Benchmark run coordinator")) {
      return { Icon: FlaskConical, isMonochromeBrandIcon: false };
    }
    if (input.agentOrgId) {
      return {
        Icon: resolveAgentIcon("network"),
        isMonochromeBrandIcon: false,
      };
    }
    if (input.cliAgentType) {
      const iconId = getIconProvider(input.cliAgentType);
      return {
        Icon: resolveAgentIcon(iconId),
        isMonochromeBrandIcon:
          iconId !== "unknown" && THEMEABLE_ICONS.has(iconId),
      };
    }
    const externalHistorySource = input.importedFrom?.externalHistorySource;
    if (externalHistorySource) {
      const descriptor = IMPORTED_HISTORY_SOURCE_DESCRIPTORS.find(
        (source) => source.sourceId === externalHistorySource
      );
      if (descriptor) {
        const provider = getIconProviderFromType(descriptor.iconId);
        return {
          Icon: resolveAgentIcon(descriptor.iconId),
          isMonochromeBrandIcon:
            provider !== "unknown" && THEMEABLE_ICONS.has(provider),
        };
      }
    }
    if (input.importedFrom) {
      return {
        Icon: resolveAgentIcon("orgii"),
        isMonochromeBrandIcon: true,
      };
    }
    if (input.agentIconId) {
      const provider = getIconProviderFromType(input.agentIconId);
      return {
        Icon: resolveAgentIcon(input.agentIconId),
        isMonochromeBrandIcon:
          provider !== "unknown" && THEMEABLE_ICONS.has(provider),
      };
    }
  }

  const sessionId = typeof input === "string" ? input : input.session_id;
  const iconId = resolveSessionIconId(sessionId);
  const provider = getIconProviderFromType(iconId);
  return {
    Icon: resolveAgentIcon(iconId),
    isMonochromeBrandIcon:
      provider !== "unknown" && THEMEABLE_ICONS.has(provider),
  };
}
