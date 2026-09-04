import type { Org2CloudAuthState } from "@src/features/Org2Cloud/org2CloudAuthState";

/** Mobile consumes the canonical browser-safe ORG2 Cloud identity shape. */
export type MobileAuthSession = Org2CloudAuthState;

interface MobileAuthStateBase {
  generation: number;
}

export type MobileAuthState =
  | (MobileAuthStateBase & { phase: "checking" })
  | (MobileAuthStateBase & { phase: "signed_out" })
  | (MobileAuthStateBase & { phase: "redirecting" })
  | (MobileAuthStateBase & { phase: "exchanging" })
  | (MobileAuthStateBase & {
      phase: "signed_in";
      session: MobileAuthSession;
      recoveredPairingIntent: string | null;
    })
  | (MobileAuthStateBase & {
      phase: "error";
      message: string;
      retryable: boolean;
    });

export type MobileAuthEvent =
  | {
      type: "begin";
      phase: "checking" | "redirecting" | "exchanging";
      generation: number;
    }
  | { type: "signed_out"; generation: number }
  | {
      type: "signed_in";
      generation: number;
      session: MobileAuthSession;
      recoveredPairingIntent: string | null;
    }
  | {
      type: "failed";
      generation: number;
      message: string;
      retryable?: boolean;
    };

export function createInitialMobileAuthState(): MobileAuthState {
  return { phase: "checking", generation: 0 };
}

/**
 * Auth is a generation-guarded FSM. Completion events from an older login,
 * refresh, callback, or logout episode cannot resurrect a discarded session.
 */
export function reduceMobileAuthState(
  state: MobileAuthState,
  event: MobileAuthEvent
): MobileAuthState {
  if (event.generation < state.generation) return state;

  switch (event.type) {
    case "begin":
      return { phase: event.phase, generation: event.generation };
    case "signed_out":
      return { phase: "signed_out", generation: event.generation };
    case "signed_in":
      return {
        phase: "signed_in",
        generation: event.generation,
        session: event.session,
        recoveredPairingIntent: event.recoveredPairingIntent,
      };
    case "failed":
      return {
        phase: "error",
        generation: event.generation,
        message: event.message,
        retryable: event.retryable ?? true,
      };
    default:
      return state;
  }
}
