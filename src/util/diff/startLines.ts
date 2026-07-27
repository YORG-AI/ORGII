interface DiffStartLineEvidence {
  args?: Record<string, unknown>;
  result?: Record<string, unknown>;
}

const PATCH_HUNK_HEADER_REGEX =
  /^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/m;

function patchTextFromArgs(
  args: DiffStartLineEvidence["args"]
): string | undefined {
  if (typeof args?.patch_text === "string") return args.patch_text;
  if (typeof args?.patch === "string") return args.patch;
  if (typeof args?.input === "string") return args.input;
  return undefined;
}

function resultHasRealDiff(result: DiffStartLineEvidence["result"]): boolean {
  if (!result) return false;
  if (
    typeof result.diffString === "string" ||
    typeof result.diff === "string"
  ) {
    return true;
  }
  if (Array.isArray(result.segments) && result.segments.length > 0) {
    return true;
  }
  const output = result.output as Record<string, unknown> | undefined;
  const success = output?.success as Record<string, unknown> | undefined;
  return Boolean(
    typeof success?.diffString === "string" || typeof success?.diff === "string"
  );
}

/** Whether line offsets attached to a file event are backed by a real diff. */
export function shouldTrustDiffStartLines(
  event: DiffStartLineEvidence | null | undefined
): boolean {
  if (!event) return false;
  const patchText = patchTextFromArgs(event.args);
  if (!patchText) return true;
  if (PATCH_HUNK_HEADER_REGEX.test(patchText)) return true;
  return resultHasRealDiff(event.result);
}
