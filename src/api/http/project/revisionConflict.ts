export const REVISION_CONFLICT_CODE = "PM_ERR:REVISION_CONFLICT";

export interface RevisionConflictDetails {
  expected: number;
  actual: number;
}

/**
 * Parse the stable named OCC error contract. The positional form is accepted
 * for compatibility with older backends during a rolling desktop upgrade.
 */
export function parseRevisionConflict(
  error: unknown
): RevisionConflictDetails | null {
  const message = error instanceof Error ? error.message : String(error);
  const named = message.match(
    /PM_ERR:REVISION_CONFLICT:expected=(-?\d+):actual=(-?\d+)/
  );
  if (named) {
    return { expected: Number(named[1]), actual: Number(named[2]) };
  }

  const legacy = message.match(/PM_ERR:REVISION_CONFLICT:(-?\d+):(-?\d+)/);
  return legacy
    ? { expected: Number(legacy[1]), actual: Number(legacy[2]) }
    : null;
}
