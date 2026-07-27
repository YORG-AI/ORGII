/**
 * Thin row-rendering adapters over the canonical session display projection.
 */
import type { LucideIcon } from "lucide-react";

import { resolveAgentIcon } from "@src/config/agentIcons";
import {
  type SessionDisplayMetadataSource,
  resolveSessionDisplayMetadata,
} from "@src/util/session/sessionDisplayMetadata";
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
  | Extract<SessionDisplayMetadataSource, { kind: "local" }>["session"];

/**
 * Resolve the icon to render in a session list row.
 *
 * Identity precedence lives in `resolveSessionDisplayMetadata`; this helper
 * only adapts its resolved icon id to the Lucide-compatible row contract.
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
  const session = typeof input === "string" ? { session_id: input } : input;
  const display = resolveSessionDisplayMetadata({ kind: "local", session });
  return {
    Icon: resolveAgentIcon(display.agentIconId),
    isMonochromeBrandIcon: display.isMonochromeBrandIcon,
  };
}
