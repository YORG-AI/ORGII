import type { RustExtractedOrgTaskData } from "@src/engines/SessionCore/core/types";

export type ResolvedOrgTaskOperationOutcome = Exclude<
  NonNullable<RustExtractedOrgTaskData["outcome"]>,
  "unknown"
>;

function resultBoolean(
  result: Record<string, unknown> | undefined,
  key: string
): boolean | undefined {
  const value = result?.[key];
  return typeof value === "boolean" ? value : undefined;
}

function resultString(
  result: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = result?.[key];
  return typeof value === "string" ? value : undefined;
}

function isErrorText(value: string | undefined): boolean {
  const normalized = value?.trimStart();
  return Boolean(
    normalized?.startsWith("Error executing") ||
    normalized?.startsWith("Error:")
  );
}

function isRejectedResult(result: Record<string, unknown> | undefined) {
  return (
    resultBoolean(result, "rejected") === true ||
    resultBoolean(result, "created") === false ||
    resultBoolean(result, "requires_dependency_confirmation") === true ||
    resultBoolean(result, "authorization_denied") === true ||
    resultBoolean(result, "already_exists") === true ||
    resultBoolean(result, "status_ignored") === true ||
    resultBoolean(result, "deleted") === false
  );
}

function isRecoverableTaskValidationError(
  result: Record<string, unknown> | undefined
): boolean {
  return ["error", "error_message", "content", "observation"].some((key) => {
    const message = resultString(result, key)?.trimStart();
    return Boolean(
      message?.startsWith("Error executing task_") &&
      message.includes(": Invalid parameters:")
    );
  });
}

function normalizedResult(
  result: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (!result) return undefined;
  for (const key of ["content", "observation"] as const) {
    const value = result[key];
    if (typeof value !== "string") continue;
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Plain-text tool output is valid; the error-text checks below still
      // inspect the unwrapped result.
    }
  }
  return result;
}

function hasObjectWithId(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.trim().length > 0;
}

/**
 * Persisted legacy events predate the explicit Rust `outcome` field. For those
 * events, success must be reconstructed from the tool result — never from the
 * args-backed `extracted.task`, because args only prove an attempt was made.
 */
function hasPersistedResultEvidence(
  extracted: RustExtractedOrgTaskData,
  result: Record<string, unknown> | undefined
): boolean {
  if (!result) return false;

  if (extracted.action === "delete") {
    return resultBoolean(result, "deleted") === true;
  }
  if (extracted.action === "list") {
    return Array.isArray(result.tasks);
  }
  if (
    extracted.action === "create" &&
    resultBoolean(result, "created") === true
  ) {
    return (
      hasObjectWithId(result.task) ||
      (Array.isArray(result.tasks) && result.tasks.some(hasObjectWithId))
    );
  }
  return hasObjectWithId(result.task);
}

/**
 * Resolve old `unknown` extracted payloads without turning an args-only task
 * attempt into successful state. Newly extracted events always carry an
 * explicit outcome; this fallback only protects persisted pre-outcome events.
 */
export function resolveOrgTaskOperationOutcome(
  extracted: RustExtractedOrgTaskData,
  result?: Record<string, unknown>,
  displayStatus?: string
): ResolvedOrgTaskOperationOutcome {
  // `outcome` is required on newly-produced payloads, but persisted events
  // from older app versions can still omit it at runtime. An explicit outcome
  // is authoritative, so avoid parsing potentially-large wrapped JSON unless
  // this is actually a legacy fallback.
  if (extracted.outcome && extracted.outcome !== "unknown") {
    return extracted.outcome;
  }

  const resolvedResult = normalizedResult(result);

  if (
    isRejectedResult(resolvedResult) ||
    isRecoverableTaskValidationError(resolvedResult) ||
    isRecoverableTaskValidationError(result)
  ) {
    return "rejected";
  }

  if (
    isErrorText(resultString(resolvedResult, "error")) ||
    isErrorText(resultString(resolvedResult, "error_message")) ||
    isErrorText(resultString(result, "content")) ||
    isErrorText(resultString(result, "observation")) ||
    displayStatus === "failed"
  ) {
    return "failed";
  }

  if (
    displayStatus === "running" ||
    displayStatus === "pending" ||
    displayStatus === "awaiting_user"
  ) {
    return "pending";
  }

  return hasPersistedResultEvidence(extracted, resolvedResult)
    ? "succeeded"
    : "failed";
}

export function isPersistedOrgTaskEvent(
  extracted: RustExtractedOrgTaskData,
  result?: Record<string, unknown>,
  displayStatus?: string
): boolean {
  return (
    resolveOrgTaskOperationOutcome(extracted, result, displayStatus) ===
    "succeeded"
  );
}
