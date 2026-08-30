export class SubmissionOutcomeUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionOutcomeUnknownError";
  }
}

export function shouldRestoreSubmissionAfterDispatchError(
  error: unknown
): boolean {
  return !(error instanceof SubmissionOutcomeUnknownError);
}
