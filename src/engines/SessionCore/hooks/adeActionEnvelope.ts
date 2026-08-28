import { extractInvokingSessionId } from "./adeReplyBinding";

export type AdeActionOperation = "list" | "inspect" | "dispatch";

export interface AdeActionDetail {
  correlationId: string;
  action?: string;
  params: Record<string, unknown>;
  operation?: AdeActionOperation;
  sessionId?: string;
  invokingSessionId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseAdeActionEnvelope(
  rawMessage: string
): AdeActionDetail | null {
  const parsed = JSON.parse(rawMessage) as unknown;
  if (!isRecord(parsed) || parsed.type !== "agent:ade_action") return null;
  const payload = parsed.payload;
  if (!isRecord(payload)) return null;

  const correlationId = payload.correlationId;
  if (typeof correlationId !== "string" || correlationId.length === 0) {
    return null;
  }

  const operation = payload.operation;
  const action = payload.action;
  const params = payload.params;
  const sessionId = payload.sessionId;
  const invokingSessionId = extractInvokingSessionId(payload);

  return {
    correlationId,
    ...(operation === "list" ||
    operation === "inspect" ||
    operation === "dispatch"
      ? { operation }
      : {}),
    ...(typeof action === "string" ? { action } : {}),
    params: isRecord(params) ? params : {},
    ...(typeof sessionId === "string" ? { sessionId } : {}),
    ...(invokingSessionId !== undefined ? { invokingSessionId } : {}),
  };
}

export function dispatchAdeActionDetail(detail: AdeActionDetail): void {
  window.dispatchEvent(
    new CustomEvent("agent-ade-action", {
      detail,
    })
  );
}
