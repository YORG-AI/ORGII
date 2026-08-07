import { ACTION_ID } from "@src/ActionSystem/actionIds";

export function extractInvokingSessionId(
  payload: Record<string, unknown>
): string | undefined {
  const value = payload.invokingSessionId;
  return typeof value === "string" ? value : undefined;
}

export function resolveTrustedDispatchParams(
  action: string | undefined,
  params: Record<string, unknown>,
  invokingSessionId: string | undefined
): Record<string, unknown> {
  if (action !== ACTION_ID.SESSION_REPLY_COMMENT) return params;
  return { ...params, localSessionId: invokingSessionId ?? "" };
}
