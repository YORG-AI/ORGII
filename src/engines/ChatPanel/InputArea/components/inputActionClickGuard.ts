const OPPOSITE_ACTION_GUARD_MS = 700;

export type InputActionKind = "submit" | "stop";

export interface InputActionGuardState {
  action: InputActionKind;
  at: number;
}

/**
 * The composer reuses one DOM button for Send and Stop. A fast second click can
 * land after React has switched the button's meaning, so suppress only the
 * opposite action from the same short gesture window. Repeating the same
 * action remains available.
 */
export function shouldSuppressOppositeInputAction(
  previous: InputActionGuardState | null,
  nextAction: InputActionKind,
  now = Date.now()
): boolean {
  return (
    previous !== null &&
    previous.action !== nextAction &&
    now - previous.at >= 0 &&
    now - previous.at < OPPOSITE_ACTION_GUARD_MS
  );
}
