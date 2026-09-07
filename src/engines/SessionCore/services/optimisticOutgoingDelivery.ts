/**
 * Transport-neutral pending -> sent/failed boundary for optimistic messages.
 *
 * The owning repository decides how a row is stored and projected. This
 * coordinator only guarantees that a transport rejection patches the same
 * optimistic row as failed instead of retracting it or restoring the draft.
 */
export async function deliverOptimisticOutgoing<TResult>(params: {
  send: () => Promise<TResult>;
  markSent: (result: TResult) => void | Promise<void>;
  markFailed: (error: unknown) => void | Promise<void>;
  onProjectionError?: (
    phase: "sent" | "failed",
    error: unknown
  ) => void | Promise<void>;
}): Promise<TResult> {
  const reportProjectionError = async (
    phase: "sent" | "failed",
    error: unknown
  ): Promise<void> => {
    try {
      await params.onProjectionError?.(phase, error);
    } catch {
      // Diagnostics are best-effort. An error reporter must never replace the
      // transport rejection or turn an already-accepted delivery into a retry.
    }
  };
  let result: TResult;
  try {
    result = await params.send();
  } catch (error) {
    try {
      await params.markFailed(error);
    } catch (projectionError) {
      await reportProjectionError("failed", projectionError);
    }
    throw error;
  }
  // The transport has accepted the message. A local projection failure from
  // this point onward must not be reclassified as a send failure: canonical
  // reconciliation/refresh can still repair the optimistic row, whereas a
  // retry would duplicate an already-accepted user intent.
  try {
    await params.markSent(result);
  } catch (projectionError) {
    await reportProjectionError("sent", projectionError);
  }
  return result;
}
