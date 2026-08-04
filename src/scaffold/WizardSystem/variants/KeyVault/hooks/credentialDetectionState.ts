export type CredentialDetectionPhase =
  | "idle"
  | "detecting_credentials"
  | "loading_catalog"
  | "selecting_credential"
  | "success"
  | "error";

export interface CredentialDetectionState {
  phase: CredentialDetectionPhase;
  credentialCount?: number;
  modelCount?: number;
  message?: string;
}

export type CredentialDetectionEvent =
  | { type: "begin" }
  | { type: "credentials_found"; count: number }
  | { type: "catalog_requested" }
  | { type: "succeeded"; modelCount: number }
  | { type: "failed"; message: string }
  | { type: "reset" };

export const INITIAL_CREDENTIAL_DETECTION_STATE: CredentialDetectionState = {
  phase: "idle",
};

export function credentialDetectionReducer(
  _state: CredentialDetectionState,
  event: CredentialDetectionEvent
): CredentialDetectionState {
  switch (event.type) {
    case "begin":
      return { phase: "detecting_credentials" };
    case "credentials_found":
      return {
        phase: "selecting_credential",
        credentialCount: event.count,
      };
    case "catalog_requested":
      return { phase: "loading_catalog" };
    case "succeeded":
      return { phase: "success", modelCount: event.modelCount };
    case "failed":
      return { phase: "error", message: event.message };
    case "reset":
      return INITIAL_CREDENTIAL_DETECTION_STATE;
  }
}

export function isCredentialDetectionPending(
  state: CredentialDetectionState
): boolean {
  return (
    state.phase === "detecting_credentials" || state.phase === "loading_catalog"
  );
}

export function getCredentialDetectionErrorMessage(
  error: unknown,
  fallback: string
): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  return fallback;
}

export function withCredentialDetectionTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(timeoutMessage));
    }, timeoutMs);

    operation.then(
      (value) => {
        clearTimeout(timeoutId);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    );
  });
}
