/**
 * Formats a dispatch/send failure toast with an optional error detail suffix.
 */
export function formatDispatchFailureMessage(
  baseMessage: string,
  detail?: string
): string {
  const trimmedDetail = detail?.trim();
  return trimmedDetail ? `${baseMessage}: ${trimmedDetail}` : baseMessage;
}
