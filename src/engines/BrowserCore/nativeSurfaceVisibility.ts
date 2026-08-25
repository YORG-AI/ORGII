export interface NativeSurfaceVisibilityState {
  isLoading: boolean;
  hasConfirmedError: boolean;
  hasTimedSensitiveHostHint: boolean;
}

/**
 * Timed host hints are advisory only. A known host such as GitHub may be
 * rendering successfully, so only an active loading panel or confirmed error
 * is allowed to move the native page offscreen.
 */
export function shouldShowNativeSurface({
  isLoading,
  hasConfirmedError,
}: NativeSurfaceVisibilityState): boolean {
  return !isLoading && !hasConfirmedError;
}
