function abortedOperationError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

/**
 * Observe a shared demand-driven operation with caller-local cancellation.
 *
 * Cancelling one mounted surface must not reject the underlying single-flight
 * promise for another equivalent consumer. Durable writes may therefore
 * finish and reconcile even after the initiating surface unmounts.
 */
export function observeSharedOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortedOperationError());

  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(abortedOperationError());
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      }
    );
  });
}
