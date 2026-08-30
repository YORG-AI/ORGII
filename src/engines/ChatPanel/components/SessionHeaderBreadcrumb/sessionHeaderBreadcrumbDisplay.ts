import {
  isAgentChildSession,
  resolveAgentChildParentSessionId,
} from "@src/util/session/agentChildSession";

export const SESSION_HEADER_NAME_MAX_CHARACTERS = 40;
export const SESSION_HEADER_PARENT_NAME_MAX_CHARACTERS = 24;
export const SESSION_HEADER_CHILD_NAME_MAX_CHARACTERS = 36;

export interface SessionHeaderBreadcrumbDisplayInput {
  sessionId: string;
  sessionName?: string | null;
  fallbackName: string;
  parentSessionId?: string | null;
  orgMemberId?: string | null;
  background?: boolean;
  parentSessionName?: string | null;
}

export interface SessionHeaderBreadcrumbDisplay {
  fullDisplayName: string;
  displayName: string;
  parentFullDisplayName?: string;
  parentDisplayName?: string;
  segments: readonly string[];
  isAgentChildSession: boolean;
}

// Re-exported so the header's existing consumers keep one import site while
// the predicate itself is shared with the message list.
export { isAgentChildSession, resolveAgentChildParentSessionId };

function truncateSessionHeaderName(
  name: string,
  maxCharacters: number
): string {
  const characters = Array.from(name);
  return characters.length > maxCharacters
    ? `${characters.slice(0, maxCharacters - 1).join("")}…`
    : name;
}

export function resolveSessionHeaderBreadcrumbDisplay(
  input: SessionHeaderBreadcrumbDisplayInput
): SessionHeaderBreadcrumbDisplay {
  const fullDisplayName =
    input.sessionName?.trim() || input.fallbackName.trim() || "Chat";
  const isAgentChild = isAgentChildSession(input);
  const displayName = truncateSessionHeaderName(
    fullDisplayName,
    isAgentChild
      ? SESSION_HEADER_CHILD_NAME_MAX_CHARACTERS
      : SESSION_HEADER_NAME_MAX_CHARACTERS
  );
  const parentSessionId = resolveAgentChildParentSessionId(
    input.sessionId,
    input.parentSessionId
  );
  const parentFullDisplayName = isAgentChild
    ? input.parentSessionName?.trim() || parentSessionId || undefined
    : undefined;
  const parentDisplayName = parentFullDisplayName
    ? truncateSessionHeaderName(
        parentFullDisplayName,
        SESSION_HEADER_PARENT_NAME_MAX_CHARACTERS
      )
    : undefined;

  return {
    fullDisplayName,
    displayName,
    ...(parentFullDisplayName && parentDisplayName
      ? { parentFullDisplayName, parentDisplayName }
      : {}),
    segments: isAgentChild
      ? [...(parentDisplayName ? [parentDisplayName] : []), displayName]
      : [displayName],
    isAgentChildSession: isAgentChild,
  };
}
