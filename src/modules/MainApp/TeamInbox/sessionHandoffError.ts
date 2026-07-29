export type SessionHandoffPreparationErrorCode =
  | "session_unavailable"
  | "project_unavailable"
  | "identity_unavailable"
  | "no_project";

export class SessionHandoffPreparationError extends Error {
  constructor(public readonly code: SessionHandoffPreparationErrorCode) {
    super(code);
    this.name = "SessionHandoffPreparationError";
  }
}

export function sessionHandoffPreparationErrorCode(
  error: unknown
): SessionHandoffPreparationErrorCode | null {
  return error instanceof SessionHandoffPreparationError ? error.code : null;
}
