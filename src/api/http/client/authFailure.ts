export type ApiTarget = "main" | "agent" | "hostedService";

export type ApiAuthRealm =
  | "legacy_main"
  | "agent_runtime"
  | "hosted_service_legacy";

export type ApiAuthFailureReason =
  | "unauthorized"
  | "credential_expired"
  | "forbidden";

export interface ApiAuthFailure {
  realm: ApiAuthRealm;
  /** Exact Broker session at request start; external realms have no session. */
  sessionId: string | null;
  target: ApiTarget;
  status: 401 | 403;
  reason: ApiAuthFailureReason;
}

const API_AUTH_REALM_BY_TARGET = {
  main: "legacy_main",
  agent: "agent_runtime",
  hostedService: "hosted_service_legacy",
} as const satisfies Record<ApiTarget, ApiAuthRealm>;

export function createApiAuthFailure(
  target: ApiTarget,
  status: 401 | 403,
  safeDetail?: string,
  sessionId: string | null = null
): ApiAuthFailure {
  const normalizedDetail = safeDetail?.trim().toLowerCase();
  const reason: ApiAuthFailureReason = normalizedDetail?.includes("expired")
    ? "credential_expired"
    : status === 401 || normalizedDetail === "not authenticated"
      ? "unauthorized"
      : "forbidden";

  return {
    realm: API_AUTH_REALM_BY_TARGET[target],
    sessionId,
    target,
    status,
    reason,
  };
}
