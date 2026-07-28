const SUBAGENT_SESSION_ID_SEGMENT = ":subagent:";
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

/**
 * A parent id also exists on ordinary continuation/import sessions, so it
 * cannot identify an agent child by itself. Agent children additionally carry
 * a subagent-shaped id, an Agent Team member id, or background-child state.
 */
export function isAgentChildSession({
  sessionId,
  parentSessionId,
  orgMemberId,
  background,
}: Pick<
  SessionHeaderBreadcrumbDisplayInput,
  "sessionId" | "parentSessionId" | "orgMemberId" | "background"
>): boolean {
  if (sessionId.includes(SUBAGENT_SESSION_ID_SEGMENT)) return true;
  if (!parentSessionId) return false;
  return Boolean(orgMemberId) || background === true;
}

export function resolveAgentChildParentSessionId(
  sessionId: string,
  parentSessionId?: string | null
): string | null {
  const explicitParentId = parentSessionId?.trim();
  if (explicitParentId) return explicitParentId;
  const segmentIndex = sessionId.indexOf(SUBAGENT_SESSION_ID_SEGMENT);
  return segmentIndex > 0 ? sessionId.slice(0, segmentIndex) : null;
}

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
